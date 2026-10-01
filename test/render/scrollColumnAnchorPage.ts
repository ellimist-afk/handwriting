/**
 * DOES THE NOTE ORIGIN STAY ON THE COLUMN WHEN THE COLUMN RECENTRES?
 *
 * Alan, Throwaway, every note, Readable line length on: ink moves with the
 * scroll and then snaps back, not left-anchored.
 *
 * THE INVARIANT, and it is physical rather than internal: note-space x = 0 must
 * render at the text column's left edge. The committed layer is rasterised once
 * against `lastPaintCam` and thereafter only carried by the band, so where
 * x = 0 actually lands is `bandLeft - lastPaintCam.x * scale`. Comparing that
 * to a FRESH column measurement each frame asks the only question that matters:
 * are the pixels currently on screen standing where the column currently is.
 *
 * WHY THIS DETECTOR AND NOT THE CALL-TIME ONE. An earlier version of this file
 * recorded `scheduleRepaint` at call time, which is right when the overlay
 * NOTICES the origin moved. The mechanism under test here is the overlay
 * failing to notice at all: `originLineObserver` is a ResizeObserver, and
 * InkOverlay's own comment at the field says "A ResizeObserver sees size, not
 * position, so it still misses a column that moves at CONSTANT line width".
 * Under Readable line length the sizer is capped at `--file-line-width` and
 * centred with auto margins, so anything that changes the SCROLLER's client
 * width - a vertical scrollbar appearing as CodeMirror's height estimate
 * settles - recentres the column by half a scrollbar while no line changes
 * size and `.cm-editor`'s box does not change either. Neither observer fires.
 * A detector that only records repaints would be silent through exactly the
 * fault it was built for; this one measures the displacement itself.
 *
 * SCAFFOLDING, DECLARED. Obsidian wraps the editor content in
 * `.cm-sizer > .cm-contentContainer` and vanilla CodeMirror 6 does not - this
 * file builds that wrapper by hand. The shape is taken from the pages in this
 * repo that already model it (columnPage.ts:63, minimalResyncPage.ts:271,
 * cameraPage.ts:200) and from MinimalCameraScale.test.ts:147, which states it
 * in the same words. It is still scaffolding: a red here is evidence about the
 * mechanism, NOT proof that Obsidian's own sizer behaves identically.
 */

import { EditorState, EditorSelection, StateEffect, StateField, Prec, Compartment } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, type DecorationSet } from "@codemirror/view";
import { Platform } from "obsidian";
import { history } from "@codemirror/commands";
import { inlineInk, inkCanvasReallocs, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, pickStripColor, setShapeSnap, setInlineTool, setInkSizeMult, getInlineTool, getInkSizeMult } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { contentOriginLeft } from "../../src/inline/ContentOrigin";
import { inkEffect } from "../../src/inline/InkHistory";
import { surfaceExtents, inkFrontier } from "../../src/inline/SurfaceExtent";
import { documentAnchorLadder } from "../../src/inline/DocumentAnchor";
import { bandMargin } from "../../src/inline/ScrollBand";
import { MAX_BACKING_AREA } from "../../src/inline/ZoomScale";
import { setPenInk } from "../../src/inline/PenInk";
import { setDiagnosticsEnabled } from "../../src/diag/DiagSwitch";
import { captureInlinePenTrace, summarizeAcquisitions } from "../../src/inline/InlinePenRouter";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { emptyPage, parsePage, serializePage, type PageData } from "../../src/model/PageData";
import { installZ10Recorder } from "./z10Recorder";
import { reticleVisible } from "../../src/testUtils/ReticleShown";

installObsidianDom();

const ids = new Map<string, string>();
/** The bboxes the last seeded arm planted, so a cell can state the ink it is asserting against. */
const seededInkBoxes: { x: number; y: number; width: number; height: number }[] = [];
const sidecars = new Map<string, string>();
let saveCost: { calls: number; ms: number; bytes: number } | null = null;
const save = (id: string, page: PageData) => {
	const t = performance.now(), bytes = serializePage(page); sidecars.set(id, bytes);
	if (saveCost) { saveCost.calls++; saveCost.ms += performance.now() - t; saveCost.bytes += bytes.length; }
};
inlineInk.attachHost({
	readPageId: p => ids.get(p) ?? null,
	claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id)!, id) : null),
	scheduleSidecar: save,
	scheduleSidecarNow: async (id, p) => save(id, p),
	notify: () => {},
});

/** The overlay prototype, reached through a mounted instance. */
let protoRef: object | null = null;
const InkOverlayPluginProto = (): object => {
	if (!protoRef) throw new Error("prototype not captured: mount first");
	return protoRef;
};

const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };

/**
 * Wide enough that the readable cap really centres rather than just fitting,
 * and deliberately NOT round.
 *
 * 1400 was the first choice and it hid the whole question: 1400 / 0.1 is
 * exactly 14000, so the counter-sized host was an integer, every rect came back
 * integral, and `visualWidth / layoutWidth` was exactly 0.1 on every frame
 * (measured scaleSpread 0.00000000). syncCamera's own comment at the epsilon
 * guard says that quotient "wobbles in its last decimals every frame" because
 * rect widths are FRACTIONAL - a fixture built on round numbers cannot produce
 * the wobble the guard exists for, so it cannot produce anything downstream of
 * it either.
 *
 * FRACTIONAL on purpose, not merely non-round: `ownedEffectiveScale` divides
 * `getBoundingClientRect().width` (fractional) by `offsetWidth` (the DOM rounds
 * it to an integer). Both terms are integral for an integer pane, so the
 * quotient is exact and cannot wobble - 1400 and 1397 both reported a spread of
 * 0.0000000000. A fractional width is the only way to make those two reads
 * disagree, which is the condition the epsilon guard was written for.
 */
/**
 * The fixture theme's own line height, and the quantum CodeMirror's height
 * estimate for unrendered lines moves in. Used to tell a re-estimate (whole
 * lines) from rect noise (fractions of one); see `offYAdj`.
 */
const LINE_H = 24;
const PANE_W = 1397.5;
const PANE_H = 800;
/** Stands in for an open sidebar; see mount(). */
const HOST_LEFT = 300;

export type Plant = "none" | "scrollbar" | "recentre" | "wide" | "hscroll" | "ic" | "icwide" | "twofinger" | "preview" | "previewPause" | "previewCommit" | "overscroll" | "minimal" | "overscrollNoIc" | "icToggle" | "icwideToggle" | "leftInk" | "leftInkToggle" | "lag" | "lagNoIc" | "lagDense" | "lagFling" | "lagFlingDense" | "lagCreep" | "bandCost" | "pinchFocal" | "pinchFocalIC" | "pinchPointer";

/**
 * The arms that run the scroll-then-draw sequence. Named once so adding one
 * cannot leave the Infinite Canvas switch, the arm's own branch and the ink
 * generator disagreeing about which plants are lag arms - which is how
 * `lagNoIc` stays the only one of them that runs with the setting off.
 */
const LAG_PLANTS: readonly Plant[] = ["lag", "lagNoIc", "lagDense", "lagFling", "lagFlingDense", "lagCreep"];
const isLag = (p: Plant): boolean => LAG_PLANTS.includes(p);

/**
 * THE ORACLE FOR FOCAL ANCHORING, and why it is a DOM rect rather than anything
 * the overlay knows about itself.
 *
 * The question Alan asked ("zoom doesn't go to where you're pinching") is about
 * where a piece of the note is PAINTED against where his finger is. Every
 * internal the overlay carries - camera, cssScale, pinchScaleNow, the band -
 * is a term in the computation under test, so an oracle built from any of them
 * can agree with a wrong answer. A `.cm-line`'s own `getBoundingClientRect()`
 * is downstream of the host transform, the counter-sized box, the pan on
 * `.cm-sizer` AND the scroll together, which is exactly the composition the
 * gesture is supposed to hold still.
 *
 * Matched by TEXT, never by index: CodeMirror renders only the lines in its
 * viewport, so `querySelectorAll(".cm-line")[16]` is a different line at every
 * zoom, and a fixed line number is off screen entirely once the arm starts
 * part-way down the note. A null here is recorded and asserted on, never
 * quietly skipped.
 */
function markerText(view: EditorView, y: number): string | null {
	let best: { el: Element; d: number } | null = null;
	for (const el of Array.from(view.contentDOM.querySelectorAll(".cm-line"))) {
		const r = el.getBoundingClientRect();
		const d = Math.abs((r.top + r.bottom) / 2 - y);
		if (!best || d < best.d) best = { el, d };
	}
	const text = best?.el.textContent ?? null;
	return text && text.length > 0 ? text : null;
}
function markerRect(view: EditorView, text: string): DOMRect | null {
	for (const el of Array.from(view.contentDOM.querySelectorAll(".cm-line"))) {
		if (el.textContent === text) return el.getBoundingClientRect();
	}
	return null;
}

interface Sample {
	at: number;
	scrollTop: number;
	/** Where note-space x = 0 actually lands on screen, from the painted camera. */
	inkOriginX: number | null;
	/** Where the text column's left edge is, measured fresh this frame. */
	columnX: number | null;
	/** inkOriginX - columnX: the visible sideways displacement, in screen px. */
	offBy: number | null;
	scrollerClientWidth: number;
	sizerLeft: number;
	editorWidth: number;
	/** Live at low pinch: the host is wider than the pane, so x can scroll. */
	scrollLeft: number;
	scrollWidth: number;
	scrollHeight: number;
	/** What Infinite Canvas has actually granted. Zero growth = a dead arm. */
	grantX: number;
	grantY: number;
	pinchPreview: boolean;
	deferArmed: boolean;
	/** scale = cssScale * fontZoom: the only free term once the column is right. */
	scale: number;
	cssScale: number;
	fontZoom: number;
	pinchNow: number;
	overflowX: string;
	axisClass: boolean;
	hscrollClass: boolean;
	/** The band's own left edge on screen - what carries the committed pixels. */
	bandLeft: number;
	/** The camera the overlay believes in now, against the one the pixels hold. */
	camX: number;
	paintX: number | null;
}

let pathForSample = "";
function sample(overlay: any, view: EditorView, sizer: HTMLElement, t0: number): Sample {
	const painted = overlay.lastPaintCam;
	const band = overlay.container as HTMLElement | null;
	const scale = overlay.scale || 1;
	// THE CANVASES LIVE IN THE INK LAYER, not directly in the band, so the
	// layer's left edge is where ink actually is on screen. Reading the band
	// instead misses any transform carried by the layer - which is where the
	// pinch-preview offset is written, deliberately, because syncCamera
	// measures the band and would otherwise absorb it.
	const inkEl = (overlay.inkLayer as HTMLElement | null) ?? band;
	const bandLeft = inkEl ? inkEl.getBoundingClientRect().left : NaN;
	const inkOriginX = painted && band ? bandLeft - painted.x * scale : null;
	const columnX = contentOriginLeft(view.contentDOM);
	return {
		at: Math.round(performance.now() - t0),
		scrollTop: Math.round(view.scrollDOM.scrollTop),
		inkOriginX,
		columnX,
		offBy: inkOriginX !== null && columnX !== null ? inkOriginX - columnX : null,
		scrollerClientWidth: view.scrollDOM.clientWidth,
		sizerLeft: sizer.getBoundingClientRect().left,
		editorWidth: view.dom.getBoundingClientRect().width,
		scrollLeft: view.scrollDOM.scrollLeft,
		scrollWidth: view.scrollDOM.scrollWidth,
		scrollHeight: view.scrollDOM.scrollHeight,
		grantX: surfaceExtents.get(pathForSample).x,
		grantY: surfaceExtents.get(pathForSample).y,
		// Was the pinch-raster suppression actually armed this frame? Without
		// this a quiet twofinger arm is indistinguishable from an unarmed one.
		pinchPreview: !!overlay.pinchPreview,
		deferArmed: !!overlay.pinchPreview && performance.now() - overlay.pinchScrollAt < 120,
		scale: overlay.scale,
		cssScale: overlay.cssScale,
		fontZoom: overlay.fontZoom,
		pinchNow: overlay.pinchScaleNow,
		overflowX: getComputedStyle(view.scrollDOM).overflowX,
		axisClass: view.scrollDOM.classList.contains("handwriting-hscroll-axis"),
		hscrollClass: view.scrollDOM.classList.contains("handwriting-hscroll"),
		bandLeft,
		camX: overlay.camera.x,
		paintX: painted ? painted.x : null,
	};
}

/**
 * Insert Obsidian's `.cm-sizer > .cm-contentContainer` between the scroller and
 * the content, which is where Obsidian puts them and where the readable-width
 * rules expect to find them.
 *
 * `.cm-content` is moved, not cloned: CodeMirror holds a reference to that
 * element and re-parenting it keeps every one of its own measurements valid,
 * where a copy would leave CM measuring a detached node.
 */
function installSizer(view: EditorView): HTMLElement {
	const scroller = view.scrollDOM;
	const content = view.contentDOM;
	const sizer = document.createElement("div");
	sizer.className = "cm-sizer";
	const container = document.createElement("div");
	container.className = "cm-contentContainer";
	content.parentElement!.insertBefore(sizer, content);
	sizer.appendChild(container);
	container.appendChild(content);
	void scroller.clientWidth;
	return sizer;
}

/**
 * A THEME THAT STILL CENTRES while the note viewport owns the editor.
 *
 * styles.css pins `.cm-sizer`'s margins under the owned-viewport class, which
 * makes the preview offset identically zero in the regime it was built for -
 * so every arm that measured that offset would then pass for a NEW reason, and
 * a regression in the offset machinery would go unseen. This restores the
 * centring the way a theme reaching the same layout through selectors the rule
 * does not name would, so those arms keep measuring what they were written for.
 *
 * `!important` on purpose: this is standing in for a theme that out-specifies
 * us, which is exactly the case the machinery is retained as a safety net for.
 */
/**
 * Minimal's shape: the sizer stays full width and the LINES are centred, with
 * `margin-inline: auto !important` (theme.css 8.1.1:1852-1867). A sizer-only
 * override does not touch this, which is why it is its own arm.
 */
function installMinimalTheme(): void {
	const st = document.head.appendChild(document.createElement("style"));
	st.textContent =
		".markdown-source-view.mod-cm6.is-readable-line-width .cm-sizer{max-width:none !important}" +
		".markdown-source-view.mod-cm6 .cm-content > *{max-width:700px;margin-inline:auto !important}";
}

function installCentringTheme(): void {
	const st = document.head.appendChild(document.createElement("style"));
	st.textContent =
		".cm-editor.handwriting-note-viewport > .cm-scroller > .cm-sizer," +
		".markdown-source-view.mod-cm6 .cm-editor.handwriting-note-viewport > .cm-scroller > .cm-sizer" +
		"{margin-left:auto !important;margin-right:auto !important}";
}

async function mount(tag: string, readable: boolean, infiniteCanvas = false, listenerMode?: "missing" | "nonfirst", hostShell = false, lines = 400, paneSize?: { w: number; h: number }) {
	const paneW = paneSize?.w ?? PANE_W, paneH = paneSize?.h ?? PANE_H;
	setPenInk(true);
	// Infinite Canvas. Alan M(direct): "if infinite canvas is on, and readable
	// line length is on, it snaps back no matter what." Every arm before this
	// ran with it OFF - the `wide` plant grew surfaceExtents by hand while the
	// expansion machinery itself was inert, so ScrollExpansionDemand never
	// sampled, never reserved, and scrollWidth never moved DURING a scroll.
	// This is the setting, not a stand-in for it.
	setScrollExpansionEnabled(infiniteCanvas);
	const path = `scroll-anchor-${tag}.md`;
	// INK SEEDED THROUGH THE SIDECAR, not through pointers. The pen path leaves this rig rejecting the
	// pinch that follows (measured: strokes committed, pinchPreviewFrames 0, caught by the arm's own
	// liveness assertion), and the ink the fit predicate cares about is the FRONTIER, which is
	// `max(bbox.x + bbox.width)` over the stroke list in NOTE-SURFACE space - not client px, and not
	// relative to the column's left edge. Writing the bbox directly is the only way to state the
	// frontier a cell is exercising, so the cell can print the number it planted.
	const seedInk = (globalThis as any).__HW_FAMILYC?.inkBbox as { frontier: number; strokeWidth?: number } | undefined;
	if (seedInk) {
		// STROKES A HAND COULD HAVE MADE. The frontier is `max(bbox.x + bbox.width)`, so it can be put
		// anywhere by writing one enormous bbox - and a cell that does that asserts against ink no pen
		// ever drew. Instead the reach is built from a ROW of ordinary strokes, each the width of a
		// written word, the last one ending exactly at the frontier the cell asks for. Every bbox here
		// is one a real stroke could produce, and the cell prints them.
		const w = seedInk.strokeWidth ?? 280;
		const inkId = `${path}-seed`;
		const page = emptyPage(inkId);
		page.surface = "inline";
		seededInkBoxes.length = 0;
		for (let i = 0, x = 40; x + w <= seedInk.frontier; i++, x += w + 90) {
			const box = { x: x + w > seedInk.frontier - w ? seedInk.frontier - w : x, y: 110 + (i % 3) * 60, width: w, height: 34 };
			seededInkBoxes.push(box);
			page.strokes.push({
				id: `family-c-seed-${i}`, tool: "pen", color: "#000000", width: 2, createdAt: i,
				points: Array.from({ length: 12 }, (_, j) => ({ x: box.x + (j / 11) * w, y: box.y + 17 + Math.sin(j) * 8, pressure: 0.5, t: i * 400 + j * 9 })),
				bbox: box,
			});
		}
		ids.set(path, inkId);
		sidecars.set(inkId, serializePage(page));
	}
	const pane = document.body.appendChild(document.createElement("div"));
	pane.className = "markdown-source-view mod-cm6" + (readable ? " is-readable-line-width" : "");
	// OFFSET FROM THE VIEWPORT BY DEFAULT, not as a one-off arm. Every rect the
	// camera path reads is viewport-relative, so a fixture with the host at
	// x = 0 silently cancels any hostLeft term in a difference of two of them -
	// which is exactly how a +270px drift with the sidebar open survived a
	// green suite. 300 stands in for an open sidebar.
	pane.style.cssText = `position:relative;margin-left:${HOST_LEFT}px;width:${paneW}px;height:${paneH}px;overflow:hidden`;
 if(hostShell){
  const leaf=document.body.appendChild(document.createElement('div'));leaf.className='workspace-leaf';leaf.style.cssText=`position:relative;margin-left:${HOST_LEFT}px;width:${paneW}px;height:${paneH}px`;
  const content=leaf.appendChild(document.createElement('div'));content.className='workspace-leaf-content';content.setAttribute('data-type','markdown');
  const vc=content.appendChild(document.createElement('div'));vc.className='view-content';vc.style.height='100%';vc.appendChild(pane);
  pane.style.cssText='position:relative;width:100%;height:100%;overflow:hidden';
 }

	const doc = Array.from({ length: lines }, (_, i) => `line ${i} alpha beta gamma delta epsilon zeta`).join("\n");

	const overlayExtensions = inkOverlayExtension() as any[];
	const overlayCompartment = new Compartment();
	// Integration fault injection through the real extension configuration.
	// The first entry installs settle's highest-precedence scroll consumer.
	if (listenerMode === 'missing') overlayExtensions.shift();
	const precedingConsumer = () => false;
	const baseExtensions = [
		history(), EditorView.lineWrapping,
		editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })),
		EditorView.theme({
			"&": { width: `${paneW}px`, height: `${paneH}px` },
			// Obsidian starts with horizontal overflow hidden; preserve that guard.
			".cm-scroller": { overflowY: "auto", overflowX: "hidden" },
			".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" },
		}),
	];
	const view = new EditorView({ parent: pane, state: EditorState.create({ doc,
		extensions: [baseExtensions.slice(0, 3), listenerMode === "nonfirst" ? Prec.highest(EditorView.scrollHandler.of(precedingConsumer)) : [], overlayCompartment.of(overlayExtensions), baseExtensions[3]!],
	}) });
	const sizer = installSizer(view);
	await settle(12);
	const overlay = overlayForPath(path) as any;
	if (overlay) protoRef = Object.getPrototypeOf(overlay);
	if (!overlay) throw new Error("no overlay for " + path);
	return { pane, view, overlay, path, sizer, overlayCompartment, overlayExtensions, baseExtensions };
}

function drawAt(view: EditorView, x: number, y: number, id: number): void {
	const pen = (type: string, px: number, py: number, buttons: number) =>
		document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, {
			bubbles: true, cancelable: true, pointerType: "pen", pointerId: id, isPrimary: true,
			clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0,
		}));
	pen("pointerdown", x, y, 1);
	pen("pointermove", x + 60, y + 20, 1);
	pen("pointermove", x + 120, y - 10, 1);
	pen("pointerup", x + 120, y - 10, 0);
}

/**
 * `drawAt` with the COMMIT separated out. `drawCommitted` runs inside the
 * pointerup dispatch, outside `repaint`, so the cost of finishing a stroke is
 * invisible to any counter that watches repaints - it has to be timed around
 * the event that carries it. Returns the pointerup cost in ms.
 */
function drawAtTimed(view: EditorView, x: number, y: number, id: number, afterMove?: () => void, samples?: { type: string; time: number }[]): number {
	let sampleTime = 0;
	const pen = (type: string, px: number, py: number, buttons: number) => {
		const target = document.elementFromPoint(px, py);
		if (!target || !view.scrollDOM.contains(target)) throw new Error(`pen misses scroller: ${px},${py}`);
		const event = new PointerEvent(type, {
			bubbles: true, cancelable: true, pointerType: "pen", pointerId: id, isPrimary: true,
			clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0,
		});
		// Same-task synthetic moves can share Chromium's quantized timestamp.
		// The production input arbiter correctly deduplicates those events.
		// Give distinct samples distinct stamps without delaying pen-down or
		// adding a settle between the measured scroll/draw phases.
		sampleTime = Math.max(event.timeStamp, sampleTime + 1);
		Object.defineProperty(event, "timeStamp", { value: sampleTime });
		samples?.push({ type, time: sampleTime });
		return target.dispatchEvent(event);
	};
	pen("pointerdown", x, y, 1);
	pen("pointermove", x + 60, y + 20, 1);
	pen("pointermove", x + 120, y - 10, 1);
	afterMove?.();
	const t = performance.now();
	pen("pointerup", x + 120, y - 10, 0);
	return Math.round((performance.now() - t) * 1000) / 1000;
}

/**
 * How much ink the lag arm puts on the page before it measures anything.
 *
 * Not a round guess at a big number: the cost under test is a whole-world
 * rasterisation, which is O(strokes on screen), and at 0.1 every stroke in the
 * note is on screen. The arm ran with three strokes first and reported a full
 * repaint at 0.3 ms - a true number about a fixture nobody has.
 */
const LAG_STROKES = 1500;

/**
 * POINTS PER STROKE, the second density axis and the one the first arm fixed
 * at 4.
 *
 * `drawStroke` costs per SEGMENT, and a captured pen stroke at a tablet's
 * sample rate carries one point every few ms - so a stroke Alan actually draws
 * is tens to hundreds of points, not four. 4 vs 200 over the SAME path is the
 * only difference between the sparse and dense arms: identical bboxes, so
 * `drawCommitted`'s viewport cull keeps exactly the same strokes in both, and
 * the ratio between their repaint times is attributable to segments alone.
 */
const LAG_POINTS_SPARSE = 4;
const LAG_POINTS_DENSE = 200;

/**
 * The polyline every injected stroke follows, in stroke-local px.
 *
 * Resampling this same path is what makes the density arm a knob rather than a
 * different fixture: at 4 points the resampler returns these four vertices
 * exactly, so the sparse arm is byte-identical to the one already measured.
 */
const LAG_PATH: readonly (readonly [number, number])[] = [[0, 0], [9, 7], [18, 0], [27, 7]];

/**
 * A FLING, not a flick. The first arm sent ONE scroll event per round; a
 * momentum scroll delivers one per frame for as long as the deceleration lasts,
 * and at 0.1 every one of them is a whole-world repaint. 30 events at one per
 * animation frame is about 500 ms of coasting on a 60 Hz surface - the arm
 * records the wall time it actually took rather than assuming it.
 */
const FLING_EVENTS = 30;

/**
 * The creep control's per-event distance, in the scroller's own layout px.
 *
 * `BAND_MARGIN_MIN` is 120 layout px and `bandMargin` only ever returns more,
 * so 10 px an event cannot reach the band's slack inside a single round - the
 * band has no reason to move and the camera no reason to change. If whole-world
 * repaints show up anyway, the reposition is not what causes them.
 */
const CREEP_PX_PER_EVENT = 10;

const FRAMES_PER_STEP = 10;
/** A displacement smaller than this is measurement noise, not a moved column. */
const VISIBLE_PX = 0.5;

/**
 * `pinch` is the arm that matters for Alan's actual vault: the notes he scrolls
 * sit near 10%. Below 1.0 the note viewport owns the host - it is counter-sized
 * wider than the pane and CSS-scaled down - so scrollLeft becomes live, the
 * band gains a horizontal margin (ScrollBand.bandFor: hMargin is 0 until
 * scrollWidth exceeds clientWidth) and the column's screen position is driven
 * by CSS variables captured once in prepareViewportLayout rather than measured
 * each frame. None of that geometry exists in the pinch-1.0 arms, which is why
 * those came back clean.
 */
async function run(readable: boolean, plant: Plant = "none", pinch = 1, centringTheme = false, offsetDisabled = false, startScrollTop = 0, zoomTo = 0.25, lagOptions?: { axis: "x" | "y" | "both"; routed?: boolean; far?: boolean; rapid?: boolean; infiniteCanvas?: boolean; frames?: number; distance?: number; pixels?: boolean; farVisual?: number; host?: boolean; zoomCycles?: number; fitCommit?: boolean; fitThenPinch?: number[]; z10?: boolean; z10TransformHost?: boolean; z10PlantLimit?: number; z10External?: number; z10ResizeBy?: number }) {
	const fitPinchSteps: { from: number; target: number; pinchScaleNow: number; cssScale: number; offsetWidth: number | null; bounceSyncs: number; bounceResized: number; bounceMoved: number }[] = [];
	if (lagOptions) Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isWin: true });
	if (centringTheme) installCentringTheme();
	if (plant === "minimal") installMinimalTheme();
	// ALAN'S ACTUAL STATE is both at once: Infinite Canvas ON and a note whose
	// ink is spread wide enough that the granted extent exceeds the
	// counter-sized host. Every earlier arm had one or the other - `wide` grew
	// the extent with the machinery off, `ic` ran the machinery on a note too
	// small to push scrollWidth past clientWidth - so hMargin never flipped in
	// either, and hMargin flipping is the only thing that moves band.left on a
	// purely vertical scroll.
	// Alan, 2026-09-20: the note zoom exists only under the Infinite Canvas. An arm that
	// pinches therefore mounts with the canvas ON, whatever its plant asks for: with the canvas
	// off the product ignores every phase of the gesture, so such an arm would measure nothing
	// and pass on the silence. Arms that never pinch keep the mode their plant chose - the
	// column, scroll and overscroll questions are canvas-off questions and stay that way.
	// The two plants named for the canvas being OFF are excluded: their whole point is the mode,
	// so flipping them would mislabel the arm. Cells that used them to reach a zoomed canvas-off
	// state are retired instead - that state no longer exists in the product.
	const armPinches = (pinch !== 1 || plant === "preview" || plant === "previewPause" || plant === "previewCommit"
		|| plant === "twofinger" || plant === "pinchFocal" || plant === "pinchFocalIC" || plant === "pinchPointer")
		&& plant !== "lagNoIc" && plant !== "overscrollNoIc";
	const rig = await mount(`${readable ? "rll" : "full"}-${plant}-${pinch}`, readable, lagOptions?.infiniteCanvas ?? (armPinches || (isLag(plant) && plant !== "lagNoIc") || plant === "ic" || plant === "icToggle" || plant === "icwide" || plant === "icwideToggle" || plant === "overscroll" || plant === "minimal"), undefined, lagOptions?.host ?? false);
	const { view, overlay, pane, sizer } = rig;
	// P2, AND IT DOES NOT REPRODUCE HERE - measured, so nobody re-runs it
	// expecting an answer. Opened-with-IC-on and opened-then-toggled come back
	// IDENTICAL: hScrollable false in both, grantX 2816, grantY 11008 -> 17664,
	// scrollWidth 13965 == clientWidth. The toggle changes nothing in this
	// fixture, so by the stated criterion this is not Alan's case.
	//
	// WHY: at pinch 0.1 the counter-sized host is 13965 wide and the grant only
	// reaches 2816, so x cannot become scrollable on EITHER path - the arm is
	// blind to the difference rather than showing there is none. A pane of
	// realistic width with ink spread across a real note is what it needs.
	//
	// P2: does a note opened with Infinite Canvas already on get a horizontal
	// range, or does it take the toggle? Alan: "i have to toggle infinite canvas
	// off and on otherwise i am only able to scroll up and down". The `ic` arm
	// mounts with it on and never toggles; this one mounts the same way and then
	// does exactly what the settings switch does.
	if (plant === "icToggle" || plant === "icwideToggle") {
		setScrollExpansionEnabled(false);
		await settle(4);
		setScrollExpansionEnabled(true);
		await settle(8);
	}
	// LIVENESS SEAM, in the harness rather than in the plugin: disabling the
	// offset lets an arm measure the drift the fix prevents, so the same fixture
	// pins the detector and the fix. Done by replacing the prototype method, NOT
	// by a flag in shipped code - a test affordance compiled into main.js is a
	// behaviour switch users carry for a guarantee only the suite needs.
	if (offsetDisabled) {
		const proto = (InkOverlayPluginProto() as unknown) as Record<string, unknown>;
		proto.applyPreviewInkOffset = function noop(): void {};
	}
	const scroller = view.scrollDOM;
	// Z10 recorder (test-only, opt-in): installed before the pinch so the zoom
	// commit's adoption and gate are recorded, not only the rounds after it.
	const z10 = lagOptions?.z10 ? installZ10Recorder(InkOverlayPluginProto() as Record<string, any>, view, overlay, { transformHost: lagOptions.z10TransformHost, plantLimit: lagOptions.z10PlantLimit }) : null;
	// An ancestor transform, as `runPixelColumn` plants one: the Z10 bypass must see a non-zoom factor and keep the ladder.
	if (lagOptions?.z10External && lagOptions.z10External !== 1) { pane.style.transform = `scale(${lagOptions.z10External})`; pane.style.transformOrigin = "0 0"; overlay.handleResize(); await settle(8); }

	const paneRect = pane.getBoundingClientRect();
	const colLeft = contentOriginLeft(view.contentDOM) ?? paneRect.left;
	drawAt(view, Math.round(colLeft + 80), Math.round(paneRect.top + 200), 91);
	await settle(8);
	drawAt(view, Math.round(colLeft + 80), Math.round(paneRect.top + 400), 92);
	await settle(8);
	const geo = () => {
		const g = (el: Element | null) => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			const c = getComputedStyle(el as HTMLElement);
			return { left: Math.round(r.left * 100) / 100, width: Math.round(r.width * 100) / 100, maxWidth: c.maxWidth, ml: c.marginLeft };
		};
		return {
			cssVar: getComputedStyle(document.body).getPropertyValue("--file-line-width").trim(),
			sizer: g(sizer),
			container: g(pane.querySelector(".cm-contentContainer")),
			content: g(view.contentDOM),
			firstLine: g(view.contentDOM.querySelector(".cm-line")),
			scroller: g(scroller),
		};
	};
	const geoBefore = geo();

	pathForSample = rig.path;
	const strokes = inlineInk.strokes(rig.path).length;

	// Apply the pinch AFTER drawing, so the strokes exist in note space at 1.0
	// exactly as they would if Alan wrote them and then zoomed out.
	if (pinch !== 1) {
		if (lagOptions?.fitCommit) {
			// Fit's own commit, the one path allowed below MIN_PINCH_SCALE. A pinch
			// to the same number settles at the manual floor instead.
			if (!(overlay as any).commitCameraScale(pinch, { left: 0, top: 0 }, undefined, false, true)) throw new Error(`fit commit at ${pinch} refused`);
			// Then one real gesture per target from wherever the last one settled,
			// recording what each settled at (below 10% zoom-out is locked).
			// Band syncs that move or resize the band while a bounce plays. Past a bound the count is a loop: the guard stops
			// calling through, so the cell reads the count on its assertion instead of losing the renderer.
			let bounceSyncs = 0, bounceResized = 0, bounceMoved = 0;
			const sync = overlay.syncBand.bind(overlay);
			overlay.syncBand = () => {
				if (overlay.bounceState && bounceSyncs > 100) return "none";
				const r = sync();
				if (r !== "none" && overlay.bounceState) { bounceSyncs++; if (r === "resized") bounceResized++; else bounceMoved++; }
				return r;
			};
			for (const target of lagOptions.fitThenPinch ?? []) {
				await settle(10);
				bounceSyncs = 0; bounceResized = 0; bounceMoved = 0;
				const r = pane.getBoundingClientRect();
				const focal = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
				const from = overlay.pinchScaleNow;
				overlay.pinch("start", 1, focal);
				overlay.pinch("move", target / from, focal);
				overlay.pinch("end", target / from, focal);
				await settle(10);
				fitPinchSteps.push({ from, target, pinchScaleNow: overlay.pinchScaleNow, cssScale: overlay.cssScale, offsetWidth: overlay.container ? (overlay.container as HTMLElement).offsetWidth : null, bounceSyncs, bounceResized, bounceMoved });
			}
		} else {
			const r = pane.getBoundingClientRect();
			const focal = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
			overlay.pinch("start", 1, focal);
			overlay.pinch("move", pinch, focal);
			overlay.pinch("end", pinch, focal);
		}
		await settle(10);
		// The scroll handler suppresses repaints for PINCH_SCROLL_QUIET_MS
		// (120ms) after the last pinch-driven scroll, and deferPinchRaster
		// gates repaint on the same window. Waiting it out is what makes the
		// scroll below an ORDINARY scroll rather than a still-pinching one -
		// otherwise any displacement found would be the documented preview
		// suppression, not a fault.
		await new Promise(r2 => setTimeout(r2, 600));
		await settle(6);
		// Z10 x C1: a pane resize at the committed scale takes handleResize's measureNaturalColumn path (the plugin's
		// zoom off the host, a measure, applyViewportBox back) before the far scroll, so the bypass reads after it.
		if (lagOptions?.z10ResizeBy) { pane.style.width = `${pane.clientWidth - lagOptions.z10ResizeBy}px`; overlay.handleResize(); await settle(8); }
	}

	// `wide` is what makes scrollLeft live at all. Counter-sizing the host does
	// NOT do it: at pinch 0.5 the scroller's client box grows with the host
	// (measured clientWidth 2800 == scrollWidth 2800), so the scaled content
	// exactly fits and there is nothing to scroll sideways. Only the SURFACE
	// EXTENT - the spacer the plugin puts inside the scroller for ink drawn
	// past the column - pushes scrollWidth beyond it. That is the state Alan's
	// notes are in, and the state in which `ScrollBand.bandFor` gives the band
	// a horizontal margin and computes its `left` from `scrollLeft`.
	// INK LEFT OF THE COLUMN, which is the whole trigger. Alan: it reproduces
	// "only ones with ink to the 'left' of the text column"; ink to the right
	// "doesn't matter for this test". The surface never goes negative, so right
	// ink is reachable without an x grant and never needs the axis opened.
	if (plant === "leftInk" || plant === "leftInkToggle") {
		surfaceExtents.grow(rig.path, { x: 4000, y: 2000 });
		overlay.updateExtent?.(true);
		await settle(10);
	}
	if (plant === "wide" || plant === "hscroll" || plant === "icwide" || plant === "icwideToggle" || plant === "twofinger" || plant === "overscroll" || plant === "minimal") {
		// Alan's own note, from the device probe recorded in
		// outputs/untitled-zoom-probe.json: fullExtent 114822 x 65483. Not a
		// round number picked to be large - at pinch 0.1 the counter-sized host
		// is only 14000 wide, so 6000 sat comfortably inside it and changed
		// nothing (measured: scrollWidth stayed 14000 == clientWidth). His real
		// extent is eight times the host, which is what makes scrollLeft live.
		surfaceExtents.grow(rig.path, { x: 114822, y: 65483 });
		overlay.scheduleRepaint("extent-plant");
		await settle(10);
	}

	// A gesture must be STARTED before "move" does anything: the first version
	// of this plant sent bare moves after the setup pinch had already settled,
	// the handler rejected every one of them, and the arm reported a confident
	// zero with pinchPreviewFrames = 0. Opened once here and never settled, so
	// the suppression stays live across the whole scroll the way a finger held
	// down does.
	if (plant === "twofinger") {
		const pr0 = pane.getBoundingClientRect();
		overlay.pinch("start", overlay.pinchScaleNow, { x: Math.round(pr0.left + pr0.width / 2), y: Math.round(pr0.top + pr0.height / 2) });
	}

	// FOCAL ANCHOR ARM. Alan on device, build fed59a8c: "zoom doesn't go to
	// where you're pinching, it zooms centered like, to the right."
	//
	// The focal point is deliberately OFF CENTRE (0.75 of the pane's width):
	// a centred one cannot distinguish "anchored under the fingers" from
	// "anchored at the middle", which is the very confusion being measured.
	// The host sits at margin-left 300 like every other arm here, so any
	// hostLeft term survives instead of cancelling.
	if (plant === "pinchFocal" || plant === "pinchFocalIC" || plant === "pinchPointer") {
		// A STARTING SCROLL SEPARATES TWO DIFFERENT FAILURES. At scrollTop 0 the
		// vertical anchor's target is negative, so a zero-move result cannot
		// distinguish "the arithmetic is wrong" from "the surface has nowhere to
		// go". The same gesture is run once at the top of the note and once well
		// into it, where the target is reachable and only the arithmetic is left.
		if (startScrollTop > 0) {
			scroller.scrollTop = startScrollTop;
			scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
			await settle(10);
			await new Promise(r2 => setTimeout(r2, 200));
			await settle(6);
		}
		const pr0 = pane.getBoundingClientRect();
		// DIAGNOSTIC OVERRIDES, defaulted to the cell's own geometry so an unset
		// harness runs byte-identically: the focal FRACTION and the zoom ladder.
		// Family C needs the finger moved without moving the page (the fraction)
		// and a finer ladder across the crossing (the ramp); both are inputs to
		// the arm, not to the code under test.
		const fcCfg: { focalFrac?: number; ramp?: number[]; inkPastColumn?: boolean; inkStrokes?: number } = (globalThis as any).__HW_FAMILYC ?? {};
		// INK PAST THE COLUMN, for the fit test's ink term. The existing ink plants grow the GRANT
		// (surfaceExtents.grow) and leave the stroke list empty, so they say nothing about a frontier
		// computed from strokes. These are real pen strokes, drawn right of the column and inside the
		// pane so the pointer lands on the scroller, before any gesture starts.
		if (fcCfg.inkPastColumn) {
			// EVERY POINT OF THE STROKE INSIDE THE SCROLLER. `drawAt` dispatches through
			// elementFromPoint and silently drops a point that misses, which leaves the pen DOWN and the
			// next pinch rejected - measured: 2 strokes of 3 committed, pinchPreviewFrames 0, caught by
			// the arm's own liveness assertion. The stroke runs +120 px right of its start, so the start
			// is capped to leave that much room plus the scrollbar gutter.
			const colRight = view.contentDOM.getBoundingClientRect().right;
			const startX = Math.min(colRight + 40, pr0.right - 200);
			for (let i = 0; i < (fcCfg.inkStrokes ?? 2); i++)
				drawAt(view, startX, pr0.top + 120 + i * 60, 900 + i);
			overlay.updateExtent?.(true);
			// LET THE PEN GO QUIET before the fingers arrive. A pinch started straight after a stroke is
			// rejected by the input arbiter - measured: pinchPreviewFrames 0, and the arm's own liveness
			// assertion caught it rather than reporting a confident zero.
			await settle(10);
			await new Promise(r2 => setTimeout(r2, 400));
			await settle(6);
		}
		const focal = { x: pr0.left + pr0.width * (fcCfg.focalFrac ?? 0.75), y: pr0.top + pr0.height * 0.5 };
		// The marker is the line the focal point actually lands on, so it cannot
		// be scrolled out of CodeMirror's rendered range at the moment it is
		// captured, and stays rendered as the zoom-out widens that range.
		const marker = markerText(view, focal.y);
		const m0 = marker ? markerRect(view, marker) : null;
		const w0 = view.contentDOM.getBoundingClientRect().width;
		if (!marker || !m0 || !(w0 > 0)) throw new Error(`pinchFocal: no marker (${marker}) or no column (${w0}) at start`);
		// The note-space offset of the focal point from the marker, in START
		// painted px. Everything else is derived from this one pair.
		const dx0 = focal.x - m0.left, dy0 = focal.y - m0.top;
		const inContent0 = m0.top - view.contentDOM.getBoundingClientRect().top;
		// The top constraint wins when holding this point would expose space
		// above the note's zero-scroll box. Keep raw focal error separately.
		const hostLeftAtStart = view.dom.getBoundingClientRect().left;
		const focalAtLeft = focal.x - hostLeftAtStart + scroller.scrollLeft * overlay.cssScale;
		const focalAtTop = focal.y - view.dom.getBoundingClientRect().top + scroller.scrollTop * overlay.cssScale;
		// READABLE LINE LENGTH ON, INFINITE CANVAS OFF: a centred column that fits the pane is not held by
		// the host's zero-scroll edge - its margin is the setting's centring - but by the pane's own edge, so on those frames
		// the boundary is the larger of the two allowances. The settle then returns the column to its centred rest.
		const columnRest = readable && plant === "pinchFocal";
		const columnRightAtStart = view.contentDOM.getBoundingClientRect().right;
		const t1 = performance.now();
		const focalFrames: any[] = [];
		const take = (phase: string): void => {
			const m = markerRect(view, marker);
			// `.cm-content` is pinned to `--handwriting-note-column-width` in
			// BOTH readable states, so its painted width over its start width
			// is the painted scale ratio - the one term needed to carry a
			// start-frame offset forward. The sizer is not usable for this:
			// with Readable line length off it is the scroller's own width,
			// which changes with the counter-sized box rather than with scale.
			const w = view.contentDOM.getBoundingClientRect().width;
			const r = w0 > 0 ? w / w0 : 1;
			const hostEdge = hostLeftAtStart + focalAtLeft * r - focal.x;
			const columnFits = columnRest && w0 * r <= pr0.width + 1;
			// WHETHER THE BOUND IS ACTUALLY BINDING ON THIS FRAME, and why the credit
			// below is conditioned on it.
			//
			// The credit excuses displacement the camera could not have avoided: the
			// scroller is at its left stop and there is nowhere further to go. That is
			// true with the setting off, and it was ASSUMED true with Infinite Canvas
			// on - where the whole point of the setting is that extent HAS been granted
			// to move into. Measured on the focal arm at e4642923: extent 1622/1315/854/
			// 393 on the frames above the exhaustion scale, `scrollLeft` 0 on every one
			// of them, and the credit paid out d(1-k) regardless - 786.09 px of it by
			// k = 0.25, so the arm printed 0 for a miss that size. The sibling arm with
			// the setting OFF, which has strictly less room, holds the same point to
			// 0.00 px through the same ladder: a displacement avoidable with less room
			// is not one the bound compelled.
			//
			// So the credit is paid only where the state says the stop was real. Read
			// from what was recorded, never from the number that was failing.
			// NO CREDIT ON A PREVIEW FRAME, in either setting. Conditioning it on the
			// scroller being at a stop with no range was not enough: below the scale
			// where the granted extent runs out, the product pays d(k_e - k)/k while
			// `maxScrollLeft` reads 0, so the condition holds, the credit pays d(1-k),
			// and the ramp prints re-rooted at k_e instead of at 1 - the same ramp, a
			// different lie. Measured: printed 31.4408 / 52.4033 against d(k_e - k) =
			// 31.4438 / 52.4062 at k = 0.42 / 0.40, k_e = 0.45.
			//
			// The sibling arm refutes the credit outright rather than narrowing it: with
			// Readable line length on and Infinite Canvas OFF the scroller has NO range at
			// any frame of this ladder, and the pan holds the focal point to 0.00 px
			// throughout. A displacement the arm with less room does not suffer was never
			// compelled by a bound, so no preview frame may charge it to one.
			// RETIRED ON EVERY FRAME, the settle included. A credit at the commit would hide the
			// -786.09 px jump the settle assertions exist to read: measured, the same settle frame
			// prints 0.0000 with the old unconditional credit and -786.0938 without it.
			const boundBinds = scroller.scrollLeft === 0 && scroller.scrollWidth - scroller.clientWidth === 0;
			const leftBoundaryShift = 0;
			// The credit as it stood before the condition, so one table carries both
			// readings and neither has to be re-run to be compared.
			const leftBoundaryShiftUnconditional = Math.min(0, columnFits ? Math.max(hostEdge, pr0.right - (focal.x + (columnRightAtStart - focal.x) * r)) : hostEdge);
			const topBoundaryShift = Math.min(0, focalAtTop * r - focal.y);
			const sc = scroller.getBoundingClientRect();
			const content = view.contentDOM.getBoundingClientRect();
			// The column's centre against the scroller's content box (the pane less its scrollbar gutter), screen px.
			const restMissX = (content.left + content.right) / 2 - (sc.left + sc.right - (sc.width - scroller.clientWidth * sc.width / scroller.offsetWidth)) / 2;
			// THE INPUT-DEATH PROBE, taken on the same frames as the anchoring.
			// A pan written on the host moves the scroller's own box off the
			// pane, and a pointer at a fixed client point then lands outside the
			// hit surface entirely. Measured on the first attempt at 0.1 zoom:
			// "input outside scroller 710,350".
			const hit = document.elementFromPoint(focal.x, focal.y);
			focalFrames.push({
				phase, r,
				at: Math.round(performance.now() - t1),
				rawOffX: m ? m.left + dx0 * r - focal.x : null, leftBoundaryShift, restMissX,
				boundBinds, leftBoundaryShiftUnconditional,
				offXOldCredit: m ? m.left + dx0 * r - focal.x - leftBoundaryShiftUnconditional : null,
				offX: m ? m.left + dx0 * r - focal.x - leftBoundaryShift : null,
				offY: m ? m.top + dy0 * r - focal.y : null,
				// THE CAMERA'S OWN SHARE of that offset.
				//
				// CodeMirror renders only its viewport and ESTIMATES the height of
				// everything above it. A pinch changes the viewport's size, the
				// estimate is redone, and the rendered lines slide inside a content
				// box that has not moved. Measured here at scrollTop 2000 with
				// Readable line length ON: the marker's offset inside `.cm-content`
				// went 2376 -> 2352 zooming out (exactly one 24px line) and
				// 2376 -> 2447.97 zooming in (three), and the raw miss was 9.60 and
				// 143.94 - the same numbers times the painted scale. Readable line
				// length OFF wraps differently, the estimate does not move, and the
				// raw miss there is 0.01.
				//
				// No pan can hold that and none should try: the text moved relative
				// to the document it lives in, which is the editor re-measuring, not
				// the camera failing to anchor. Subtracting it is what leaves the
				// question this arm exists to ask. BOTH are reported, so a reviewer
				// can see how much of a raw miss was ever the camera's.
				inContent: m ? m.top - view.contentDOM.getBoundingClientRect().top : null,
				// QUANTISED TO WHOLE LINES, which is the whole point: CodeMirror's
				// estimate moves in line heights, and everything smaller is the
				// fractional disagreement between two rect reads. Rounding first is
				// what stops the correction manufacturing an error of its own -
				// measured with Readable line length OFF, where the raw miss is 0.05
				// and an unrounded 0.87px "shift" turned it into 1.75.
				topBoundaryShift,
				offYAdj: m ? m.top + dy0 * r - focal.y - topBoundaryShift
					- Math.round(((m.top - view.contentDOM.getBoundingClientRect().top) / r - inContent0) / LINE_H) * LINE_H * r : null,
				markerLeft: m ? Math.round(m.left * 100) / 100 : null,
				markerTop: m ? Math.round(m.top * 100) / 100 : null,
				// WHERE THE LINE SITS INSIDE `.cm-content`, in note units. CodeMirror
				// renders only the viewport and ESTIMATES the height of everything
				// above it, so a changed viewport size re-estimates and the rendered
				// lines slide inside the content box with the content box itself
				// standing still. That is the editor re-measuring, not the camera
				// moving, and it is the one displacement no pan can or should hold.
				markerInContent: m && w0 > 0 && r > 0 ? Math.round(((m.top - view.contentDOM.getBoundingClientRect().top) / r) * 100) / 100 : null,
				scrollLeft: Math.round(scroller.scrollLeft * 100) / 100,
				scrollTop: Math.round(scroller.scrollTop * 100) / 100,
				// What the browser would let the scroll reach. A target outside
				// this is silently clamped, which is a residual and not a pass.
				maxScrollLeft: scroller.scrollWidth - scroller.clientWidth,
				maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
				hostLeft: Math.round(view.dom.getBoundingClientRect().left * 100) / 100,
				hostTop: Math.round(view.dom.getBoundingClientRect().top * 100) / 100,
				scrollerLeft: Math.round(sc.left * 100) / 100,
				scrollerTop: Math.round(sc.top * 100) / 100,
				hitsScroller: !!hit && scroller.contains(hit),
				transform: view.dom.style.transform,
				sizerTransform: (view.dom.querySelector(".cm-sizer") as HTMLElement | null)?.style.transform ?? "",
				layerTransform: (view.dom.querySelector(".handwriting-ink-layer") as HTMLElement | null)?.style.transform ?? "",
				bandTransform: (view.dom.querySelector(".handwriting-ink-overlay") as HTMLElement | null)?.style.transform ?? "",
				pinchNow: overlay.pinchScaleNow,
				pinchPreview: !!overlay.pinchPreview,
				columnX: contentOriginLeft(view.contentDOM),
				settlePans: (globalThis as any).__HW_SETTLE_PAN ? [...(globalThis as any).__HW_SETTLE_PAN] : null,
				// PRODUCTION'S OWN FIT QUANTITIES, so a cell asserting the centred rest asks the same box the
				// code does rather than re-deriving it: contentX is the content box (column union ink) and
				// viewportX the span it is measured against, both painted px.
				fit: (() => { try { const f = overlay.panFitReadout?.(); return f ? { fitsX: f.fitsX, contentX: f.contentX, viewportX: f.viewportX } : null; } catch { return null; } })(),
				marginVar: view.dom.style.getPropertyValue("--handwriting-column-margin-left"),
				// THE TWO CANDIDATE QUANTITIES side by side, and where the ink actually ended up.
				// `grantX` is what production's fit test reads (the ink claim OR the zoom/scroll grants,
				// conflated); `inkOnlyX` is the ruling's definition read strictly. The layer rect is the
				// painted answer, against the pane it has to stay on.
				grantX: surfaceExtents.get(rig.path)?.x ?? 0,
				inkOnlyX: inkFrontier(inlineInk.strokes(rig.path)).x,
				layerLeft: Math.round(((view.dom.querySelector(".handwriting-ink-layer") as HTMLElement | null)?.getBoundingClientRect().left ?? NaN) * 100) / 100,
				layerRight: Math.round(((view.dom.querySelector(".handwriting-ink-layer") as HTMLElement | null)?.getBoundingClientRect().right ?? NaN) * 100) / 100,
				paneLeft: Math.round(pr0.left * 100) / 100, paneRight: Math.round(pr0.right * 100) / 100,
			});
		};
		// Zoom OUT passes through 0.5 on its way to 0.25; zoom IN is the same
		// gesture run the other way, where the scroll target is reachable and
		// only the arithmetic is under test.
		const ramp = zoomTo < 1
			? (fcCfg.ramp ?? [0.9, 0.75, 0.6, 0.5, 0.4, 0.3, zoomTo])
			: [1.1, 1.25, 1.4, 1.6, 1.8, 1.9, zoomTo];
		take("start");
		overlay.pinch("start", 1, focal);
		for (const k of ramp) {
			overlay.pinch("move", k, focal);
			await frame();
			take(`k=${k}`);
		}
		// THE POINTER ARM, taken while the pan is LIVE and the preview is still
		// on screen: the note has been translated and the scroller has not, so
		// this is the state the input-death class lived in.
		const preview = focalFrames[focalFrames.length - 1]!;
		overlay.pinch("end", zoomTo, focal);
		await settle(14);
		// DIAGNOSTIC SAMPLES, excluded from the red condition: where between
		// the commit and the quiet window a scroll is refunded is a different
		// question from whether the note ends up in the right place, and a
		// single settle reading cannot tell the two apart.
		take("post1");
		// Past PINCH_SCROLL_QUIET_MS and the deferred repaint, so "after the
		// gesture settles" means settled and not merely suppressed.
		await new Promise(r2 => setTimeout(r2, 400));
		take("post2");
		await settle(8);
		take("settle");
		// A PEN AT THE TRANSLATED NOTE POSITION. Not at a remembered screen
		// point: the whole question is whether the note, wherever the anchoring
		// has put it, is still reachable by the pen. The router's answer is a
		// committed stroke, which is the only end-to-end evidence there is.
		let penStrokes = 0, penHit = false, penPoint: unknown = null;
		if (plant === "pinchPointer") {
			// At the top boundary the original focal line moves toward the top
			// and can sit behind the fixed toolbar. Pick a currently visible line
			// near the pane centre; retain the original marker for focal tracking.
			const penMarker = markerText(view, focal.y);
			const m = penMarker ? markerRect(view, penMarker) : null;
			if (m) {
				const px = Math.round(m.left + Math.min(40, m.width / 3)), py = Math.round((m.top + m.bottom) / 2);
				const el = document.elementFromPoint(px, py);
				penPoint = { x: px, y: py, target: el?.className, marker: { left: m.left, top: m.top, width: m.width, height: m.height }, scroller: scroller.getBoundingClientRect().toJSON() };
				penHit = !!el && scroller.contains(el);
				const before = inlineInk.strokes(rig.path).length;
				drawAt(view, px, py, 93);
				await settle(10);
				penStrokes = inlineInk.strokes(rig.path).length - before;
			}
		}
		// POSITIVE CONTROL. Every number above is a difference of rects; a probe
		// that cannot see a real displacement reports a confident zero. Push the
		// host 10px sideways and 7px down and read it back.
		// On the zoom host the host is itself zoomed, so a translate written on it
		// renders at translate x zoom: planted as 10/zoom and 7/zoom, the SCREEN
		// displacement is still 10 and 7, and the test keeps its numbers.
		const probeZoom = Number.parseFloat(getComputedStyle(view.dom).zoom) || 1;
		const baseTransform = view.dom.style.transform;
		view.dom.style.transform = `translate(${10 / probeZoom}px,${7 / probeZoom}px) ${baseTransform}`;
		take("probe");
		view.dom.style.transform = baseTransform;
		const probe = focalFrames[focalFrames.length - 1]!;
		const gesture = focalFrames.filter((f: any) => f.phase !== "start" && f.phase !== "probe" && !f.phase.startsWith("post"));
		const previewOnly = focalFrames.filter((f: any) => f.phase.startsWith("k="));
		const settled = focalFrames[focalFrames.length - 2]!;
		// A settle whose centred column fits returns it to its rest, not to the focal point: that frame's x is read against the rest.
		const restSettle = columnRest && w0 * settled.r <= pr0.width + 1;
		const offG = gesture.filter((f: any) => f.offX === null || f.offYAdj === null || (!(restSettle && f === settled) && Math.abs(f.offX) > 1) || Math.abs(f.offYAdj) > 1);
		// READ BEFORE destroy(): tearing the view down runs restoreViewportLayout,
		// which resets pinchScaleNow to 1 - a read taken after it reports "the
		// pinch never took" for a pinch that did.
		const viewportOwned = !!overlay.viewportLayout, pinchNow = overlay.pinchScaleNow;
		view.destroy();
		pane.remove();
		return {
			readable, plant, pinch, strokes, columnLeftAtStart: colLeft,
			focal, samples: focalFrames.length,
			// THE GEOMETRY THE FIT QUESTION IS ASKED OF. `.cm-content` is pinned to
			// `--handwriting-note-column-width`, which the plugin writes: the column is NOT
			// the stylesheet's `--file-line-width`, so whether the page fits the pane at a
			// given scale cannot be computed from the fixture's constants. Reported so the
			// crossing k* = paneW / w0 is read from the run rather than assumed.
			w0, paneW: pr0.width, paneH: pr0.height,
			// The focal point's distance from the host's left edge at gesture start. Every x term on this
			// arm is a multiple of it, so a cell that pins one must read it rather than spell a number.
			focalHostDx: focalAtLeft,
			/** The frontier this arm PLANTED (bbox.x + bbox.width), so a failure message can state it. */
			seededInkFrontier: seededInkBoxes.length ? Math.max(...seededInkBoxes.map(b => b.x + b.width)) : null,
			/** Every planted bbox, for the cell's failure message: ink a cell asserts on must be ink a pen could draw. */
			seededInkBoxes: seededInkBoxes.map(b => ({ ...b })),
			startScrollWidth: scroller.scrollWidth, startScrollHeight: scroller.scrollHeight,
			focalFrames,
			// THE RED CONDITION: frames whose anchored note point is not under
			// the focal point, preview frames and the settled frame alike.
			offFrames: offG.length,
			maxOffBy: gesture.length ? Math.max(...gesture.map((f: any) => Math.max(Math.abs(f.offX ?? 1e9), Math.abs(f.offY ?? 1e9)))) : 0,
			maxOffX: gesture.length ? Math.max(...gesture.map((f: any) => Math.abs(f.offX ?? 1e9))) : 0,
			maxOffY: gesture.length ? Math.max(...gesture.map((f: any) => Math.abs(f.offYAdj ?? 1e9))) : 0,
			maxOffYRaw: gesture.length ? Math.max(...gesture.map((f: any) => Math.abs(f.offY ?? 1e9))) : 0,
			// How far CodeMirror moved the marker inside `.cm-content` over the
			// gesture, in note px. Non-zero means the raw numbers above carry a
			// displacement no camera produced.
			cmEstimateShift: Math.max(...focalFrames.filter((f: any) => f.phase !== "probe" && f.inContent !== null && f.r > 0)
				.map((f: any) => Math.abs(Math.round((f.inContent / f.r - inContent0) / LINE_H) * LINE_H))),
			// THE PREVIEW COUNT READS THE RAW OFFSETS. It used `offYAdj`, which is `offY` less
			// `topBoundaryShift` and a line-quantisation term. `topBoundaryShift` is min(0, focalAtTop*r -
			// focal.y): large and negative at scrollTop 0, exactly 0 at scrollTop 2000. Measured on the
			// top=0 arms: offY is 0 (+/-0.1) on EVERY preview frame while offYAdj climbs to 300, and this
			// one change took the count 7 -> 0 with nothing else altered. The note IS held under the
			// fingers; the 300 was this oracle's own top pin. offYAdj is unchanged and still in the trace.
			previewOffFrames: previewOnly.filter((f: any) => f.offX === null || f.offY === null || Math.abs(f.offX) > 1 || Math.abs(f.offY) > 1).length,
			maxPreviewOff: previewOnly.length ? Math.max(...previewOnly.map((f: any) => Math.max(Math.abs(f.offX ?? 1e9), Math.abs(f.offY ?? 1e9)))) : 0,
			settleOffX: settled.offX, settleOffY: settled.offYAdj, settleOffYRaw: settled.offY,
			// The bound's own geometry at the settle, so the cell derives the rest the ruling
			// line 4 puts the page on rather than pinning a number.
			bound: typeof (overlay as any).overscrollBounceReadout === "function"
				? (() => { const b = (overlay as any).overscrollBounceReadout(); return { floorX: b.floorX, floorY: b.floorY, bx: b.bx, width: b.width, rawX: b.rawX, cx: b.cx, rawY: b.rawY, cy: b.cy }; })()
				: null,
			restSettle, settleRestMissX: settled.restMissX,
			endsOff: settled.offX === null || settled.offYAdj === null || Math.abs(restSettle ? settled.restMissX : settled.offX) > 1 || Math.abs(settled.offYAdj) > 1,
			// THE SETTLE-SIGN CHECK: the settled frame must land where the last
			// preview frame stood. A jump at pinch end is its own defect even
			// when both ends are wrong by the same amount.
			settleJumpX: previewOnly.length && settled.offX !== null && previewOnly[previewOnly.length - 1]!.offX !== null
				? settled.offX - previewOnly[previewOnly.length - 1]!.offX : null,
			settleJumpY: previewOnly.length && settled.offYAdj !== null && previewOnly[previewOnly.length - 1]!.offYAdj !== null
				? settled.offYAdj - previewOnly[previewOnly.length - 1]!.offYAdj : null,
			// THE CLOSE THAT JUMP OWES, from the frame the lift happened on. exposureY is -topBoundaryShift
			// by construction, so -max(exposureY, 0) is that frame's topBoundaryShift, which is <= 0 already.
			settleJumpYLaw: previewOnly.length ? (previewOnly[previewOnly.length - 1]!.topBoundaryShift ?? 0) : 0,
			// LIVENESS. A gesture the overlay rejected moves nothing and is off
			// by nothing, which reads exactly like a pass.
			scaleRatioSpread: Math.max(...focalFrames.map((f: any) => f.r)) - Math.min(...focalFrames.map((f: any) => f.r)),
			markerMoved: Math.max(...gesture.map((f: any) => Math.hypot((f.markerLeft ?? m0.left) - m0.left, (f.markerTop ?? m0.top) - m0.top))),
			markerNulls: focalFrames.filter((f: any) => f.markerLeft === null).length,
			pinchPreviewFrames: previewOnly.filter((f: any) => f.pinchPreview).length,
			// THE POINTER ARM'S OWN RESULTS, and the liveness that makes them
			// mean something: a pan of zero proves nothing about a translated
			// note being reachable.
			penStrokes, penHit, penPoint,
			previewHitsScroller: preview.hitsScroller,
			previewSizerTransform: preview.sizerTransform,
			previewLayerTransform: preview.layerTransform,
			previewBandTransform: preview.bandTransform,
			previewHostTransform: preview.transform,
			previewScrollerLeft: preview.scrollerLeft,
			// GESTURE FRAMES ONLY. The probe frame translates the host on purpose,
			// to prove the oracle can see a displacement; reading it back as "the
			// host is translated" would make the planted control fail the guard it
			// exists to validate.
			hostTransforms: [...new Set(gesture.map((f: any) => f.transform))],
			sizerTransforms: [...new Set(gesture.map((f: any) => f.sizerTransform))],
			bandTransforms: [...new Set(gesture.map((f: any) => f.bandTransform))],
			// The probe frame deliberately translates the host, which moves the
			// scroller with it - that is the very displacement it is planted to
			// prove the oracle can see, and it is not the gesture.
			scrollerLefts: [...new Set(gesture.map((f: any) => f.scrollerLeft))],
			hitFrames: focalFrames.filter((f: any) => f.hitsScroller).length,
			// Non-zero means the rect reads can see a displacement at all.
			probeSeesX: probe.offX === null ? 0 : probe.offX - (settled.offX ?? 0),
			probeSeesY: probe.offYAdj === null ? 0 : probe.offYAdj - (settled.offYAdj ?? 0),
			// The host form the plant was sized for, read rather than assumed: the host's zoom, the overlay's gate, the engine.
			probeZoom, hostZoom: (overlay as any).hostZoomSupported() as boolean, engineZoom: CSS.supports("zoom", "0.5"),
			pinchNow, startScrollTop, zoomTo,
			// THE SCALE THE LADDER ACTUALLY ENDED AT. `zoomTo` names the arm; a
			// diagnostic ramp may stop elsewhere, and an end-scale assert against the
			// arm's name then fails for the rig's reason instead of the page's.
			rampEnd: ramp[ramp.length - 1],
			scrollLefts: [...new Set(focalFrames.map((f: any) => f.scrollLeft))],
			scrollTops: [...new Set(focalFrames.map((f: any) => f.scrollTop))],
			maxScrollLefts: [...new Set(focalFrames.map((f: any) => f.maxScrollLeft))],
			trace: focalFrames.map((f: any) => [f.phase, f.scrollTop, f.markerInContent,
				f.offY === null ? null : Math.round(f.offY * 100) / 100,
				f.offYAdj === null ? null : Math.round(f.offYAdj * 100) / 100]),
			viewportOwned,
			scrolled: true, sizerCentred: true, detectorProves: 0, probeScale: 0,
			hScrollable: false, scrollWidths: [], clientWidthsSeen: [],
			icGranted: false, scanNulls: 0, scaleSpread: 0, grantXs: [], grantYs: [],
			scrollHeights: [], overflowXs: [], columnMoves: [], sizerLefts: [], bandLefts: [],
			plantedAt: [], healedOffBy: settled.offX, offDetail: offG.slice(0, 8),
			columnXs: [...new Set(focalFrames.map((f: any) => f.columnX))],
			deferArmedFrames: 0, geoBefore, geoAfter: null,
		} as any;
	}

	// PREVIEW ARM. The gesture itself is the trigger (Alan: "the ink moves when
	// zooming out"), so this pinches k0=1 -> k=0.1 and samples DURING the
	// gesture, never settling: commitCameraScale at pinch end is precisely what
	// heals it, so a sample taken after the end can only ever be green.
	if (plant === "preview" || plant === "previewPause" || plant === "previewCommit") {
		const pr0 = pane.getBoundingClientRect();
		const focal = { x: Math.round(pr0.left + pr0.width / 2), y: Math.round(pr0.top + pr0.height / 2) };
		const t1 = performance.now();
		const previewSamples: Sample[] = [];
		overlay.pinch("start", 1, focal);
		for (const k of [0.9, 0.75, 0.6, 0.45, 0.3, 0.2, 0.15, 0.1]) {
			overlay.pinch("move", k, focal);
			await frame();
			previewSamples.push(sample(overlay, view, sizer, t1));
			// PAUSE ARM: hold the gesture still past PINCH_SCROLL_QUIET_MS
			// (120ms) at the half-way point. deferPinchRaster then goes false,
			// syncCamera runs for its own reasons, and anything pairing the
			// column it writes with a scale recorded elsewhere is now comparing
			// two different moments. A finger resting mid-pinch does this.
			// COMMIT MID-GESTURE. A pen landing during a touch pinch writes the
			// committed canvas through drawCommitted, outside repaint. That path
			// clears the preview offset and marks the layer dirty; the frame it
			// schedules is then consumed by repaint's deferral and, without the
			// latch, never redrawn - so the rest of the layer sits at the
			// pre-gesture raster, untranslated, for the remainder of the pinch.
			if (plant === "previewCommit" && k === 0.45) {
				const pr2 = pane.getBoundingClientRect();
				drawAt(view, Math.round(pr2.left + 120), Math.round(pr2.top + 260), 93);
				// Keep previewing past PINCH_SCROLL_QUIET_MS with no end event.
				await new Promise(r2 => setTimeout(r2, 260));
				await settle(4);
			}
			if (plant === "previewPause" && k === 0.45) {
				await new Promise(r2 => setTimeout(r2, 200));
				overlay.syncCamera?.();
				view.scrollDOM.dispatchEvent(new Event("scroll", { bubbles: true }));
				await settle(3);
			}
		}
		const offP = previewSamples.filter(s => s.offBy !== null && Math.abs(s.offBy) > VISIBLE_PX);
		overlay.pinch("end", 0.1, focal);
		await settle(12);
		const healed = sample(overlay, view, sizer, t1);
		view.destroy();
		pane.remove();
		return {
			readable, plant, pinch, strokes, columnLeftAtStart: colLeft,
			samples: previewSamples.length,
			offFrames: offP.length,
			maxOffBy: offP.length ? Math.max(...offP.map(s => Math.abs(s.offBy!))) : 0,
			endsOff: healed.offBy !== null && Math.abs(healed.offBy) > VISIBLE_PX,
			healedOffBy: healed.offBy,
			offDetail: offP.slice(0, 8),
			columnXs: [...new Set(previewSamples.map(s => (s.columnX === null ? "null" : s.columnX.toFixed(2))))],
			scales: [...new Set(previewSamples.map(s => s.scale))],
			pinchPreviewFrames: previewSamples.filter(s => s.pinchPreview).length,
			deferArmedFrames: previewSamples.filter(s => s.deferArmed).length,
			scrolled: true, sizerCentred: true, detectorProves: 0, probeScale: 0,
			hScrollable: false, scrollLefts: [], scrollWidths: [], clientWidthsSeen: [],
			icGranted: false, scanNulls: 0, scaleSpread: 0, grantXs: [], grantYs: [],
			scrollHeights: [], overflowXs: [], columnMoves: [], sizerLefts: [], bandLefts: [],
			plantedAt: [], yDriftFrames: 0, maxYDrift: 0, xDriftFrames: 0, maxXDrift: 0,
			yDriftDetail: [], xDriftDetail: [], lastOffAt: null, cssScales: [], fontZooms: [],
			viewportOwned: !!overlay.viewportLayout, pinchNow: overlay.pinchScaleNow,
			geoBefore: null, geoAfter: null, cascade: null, recorderWorks: true,
			viaTally: {}, originMoveCalls: 0, sidewaysMoves: 0, verticalMoves: 0,
			maxSidewaysDx: 0, maxVerticalDy: 0, originMoveDetail: [],
		} as any;
	}

	// OVER-SCROLL LEFT. Alan on 2af394d9, IC+RLL on: "i can still scroll left
	// of Untitled 2 and that's unwanted behavior."
	//
	// Under Readable line length the column is centred inside the counter-sized
	// host, so there is a wide empty band to its LEFT inside the scroller's
	// content. Without Infinite Canvas that band is unreachable - scrollWidth
	// equals clientWidth, so scrollLeft is pinned at 0 and the pane simply shows
	// the centred column. Infinite Canvas grants x extent, scrollWidth exceeds
	// clientWidth, and the whole band becomes scrollable: scrollLeft 0 now parks
	// the viewport on empty space left of the note.
	//
	// MEASURED: the minimum reachable scrollLeft against the column's own left
	// edge in scroller-content units. The arm also records that scrollWidth
	// really did grow, so it cannot pass by simply never becoming scrollable.
	if (plant === "overscroll" || plant === "minimal" || plant === "overscrollNoIc") {
		const scr = view.scrollDOM;
		// THE LIVE FOCAL PAN, taken off before the column is converted.
		//
		// `contentOriginLeft` reads `.cm-content`, which rides inside `.cm-sizer`,
		// and the pinch's focal anchor translates `.cm-sizer`. Left in, this
		// detector reports column PLUS pan and stops testing the freeze at all -
		// measured at k=0.1 as 6632.25 where the column is 341.25, which is the
		// 629.1 painted px of pan the arm's own zoom-out left behind, divided by
		// the 0.1 scale. Read from the overlay's pan state rather than parsed back
		// out of the transform string: the string is a rendering of this number,
		// and a detector that re-derives its correction from the thing it is
		// checking cannot fail when the two disagree.
		const panNow = (): number => {
			const pan = (overlay as any).viewportPan;
			return pan && Number.isFinite(pan.x) ? pan.x : 0;
		};
		const columnContentX = (): number => {
			const col = contentOriginLeft(view.contentDOM);
			if (col === null) return NaN;
			const r = scr.getBoundingClientRect();
			// Painted px on both terms before the division: `col` and the pan are
			// both screen numbers, the quotient is host-local.
			return (col - panNow() - r.left) / (overlay.cssScale || 1) + scr.scrollLeft;
		};
		const before = { scrollWidth: scr.scrollWidth, clientWidth: scr.clientWidth };
		// Scroll hard left, as a finger would.
		scr.scrollLeft = -100000;
		scr.dispatchEvent(new Event("scroll", { bubbles: true }));
		await settle(10);
		const minScrollLeft = scr.scrollLeft;
		const panAtMin = panNow();
		const columnAtMin = columnContentX();
		let panProbe: { pan: number; corrected: number } | null = null;
		if (plant === "overscroll" && pinch < 1) {
			const f = { x: paneRect.left + 600, y: paneRect.top + 400 };
			overlay.pinch("start", 1, f); overlay.pinch("move", 1, { x: f.x - 150, y: f.y }); await frame();
			panProbe = { pan: panNow(), corrected: columnContentX() };
			overlay.pinch("end", 1, { x: f.x - 150, y: f.y }); await settle(8);
		}
		// Where the space went: the LEFT bound should move to the column while
		// the RIGHT bound is untouched - the rule removes reachable emptiness,
		// it does not shorten the surface.
		scr.scrollLeft = 1e7;
		scr.dispatchEvent(new Event("scroll", { bubbles: true }));
		await settle(6);
		const maxScrollLeft = scr.scrollLeft;
		view.destroy();
		pane.remove();
		return {
			readable, plant, pinch, strokes,
			scrollWidthBefore: before.scrollWidth,
			clientWidthBefore: before.clientWidth,
			// Liveness: if the surface never became horizontally scrollable the
			// arm proves nothing, because scrollLeft could not have moved at all.
			hScrollable: before.scrollWidth > before.clientWidth,
			minScrollLeft,
			maxScrollLeft,
			// Reported so the de-pan above can be shown to be load-bearing rather
			// than assumed: a zero here would mean the subtraction corrected
			// nothing and the arm would be passing for the wrong reason.
			panAtMin, panProbe,
			columnContentX: columnAtMin,
			// THE RED CONDITION: reachable space to the left of the column.
			overscrollLeft: Number.isFinite(columnAtMin) ? columnAtMin - minScrollLeft : NaN,
			offFrames: 0, maxOffBy: 0, endsOff: false, offDetail: [], columnXs: [],
			samples: 1, scrolled: true, sizerCentred: true, detectorProves: 0, probeScale: 0,
			scrollLefts: [], scrollWidths: [], clientWidthsSeen: [], icGranted: false,
			scanNulls: 0, scaleSpread: 0, grantXs: [], grantYs: [], scrollHeights: [],
			pinchPreviewFrames: 0, deferArmedFrames: 0, healedOffBy: 0, lastOffAt: null,
			viewportOwned: !!overlay.viewportLayout, pinchNow: overlay.pinchScaleNow,
		} as any;
	}

	// WHAT THE BAND COSTS AT A SCALE NOBODY FLOORS.
	//
	// 0.1 is not the reachable minimum. `MIN_NOTE_ZOOM` floors the zoom-out
	// BUTTON; pinch and Fit are deliberately unfloored, and fitHandwriting has
	// been measured at 0.019176 on a far-ink note. Lifting the band's ceiling by
	// 1/scale is only safe if the band's cost does not follow 1/scale with it,
	// so this arm reads the cost rather than arguing about it: the margin
	// actually used, the band's layout box, and the five canvases' real backing.
	//
	// THE SAME ARM RUNS AT 1.0, on the same pane, because the claim under test
	// is an EQUALITY - that a zoomed-out band costs what the 1.0 band already
	// costs - and an equality needs both sides measured by one instrument.
	if (plant === "bandCost") {
		// The SAME surface the fling arms run on, so the two sets of numbers
		// can be compared: this grant is what makes the band spend a horizontal
		// margin at all, and the horizontal margin is half the band's area.
		// The pinched arm keeps the exact 60000x20000 it has always grown. A Fit
		// arm below ten percent needs the same grant IN ITS OWN px or the
		// counter-sized client (73538 wide at 0.019) swallows it, the surface
		// stops being sideways scrollable, and the two arms would differ in
		// whether they spend a horizontal margin at all - which is the one thing
		// the equality below needs them to share.
		const grant = lagOptions?.fitCommit ? Math.ceil(1 / pinch) : 1;
		surfaceExtents.grow(rig.path, { x: 60000 * grant, y: 20000 * grant });
		(overlay as any).updateExtent(true);
		await settle(10);
		const scroller3 = view.scrollDOM;
		const cssScale = overlay.cssScale;
		const canvases = [...pane.querySelectorAll("canvas")].map(c => ({
			w: (c as HTMLCanvasElement).width,
			h: (c as HTMLCanvasElement).height,
			px: (c as HTMLCanvasElement).width * (c as HTMLCanvasElement).height,
		}));
		const band = overlay.band as { left: number; top: number; width: number; height: number } | null;
		const out = {
			readable, plant, pinch, strokes: inlineInk.strokes(rig.path).length,
			cssScale, fitPinchSteps,
			// The two numbers the overlay's own measurement divides (rect / offset),
			// read here so a tolerance derived from the layout width can be stated
			// beside the scale it bounds.
			containerRectWidth: overlay.container ? (overlay.container as HTMLElement).getBoundingClientRect().width : null,
			containerOffsetWidth: overlay.container ? (overlay.container as HTMLElement).offsetWidth : null,
			clientWidth: scroller3.clientWidth,
			clientHeight: scroller3.clientHeight,
			scrollWidth: scroller3.scrollWidth,
			scrollHeight: scroller3.scrollHeight,
			// bandMargin's own answer, from the shipped function, not a copy of
			// its rule - the whole point is to catch a rule that disagrees with
			// what the band actually got.
			margin: bandMargin(scroller3.clientHeight, cssScale),
			marginVisual: Math.round(bandMargin(scroller3.clientHeight, cssScale) * cssScale * 100) / 100,
			marginAtOne: bandMargin(scroller3.clientHeight),
			band,
			bandVisual: band ? { width: Math.round(band.width * cssScale * 100) / 100, height: Math.round(band.height * cssScale * 100) / 100 } : null,
			canvases,
			canvasCount: canvases.length,
			maxCanvasPx: canvases.length ? Math.max(...canvases.map(c => c.px)) : 0,
			backingPx: canvases.reduce((n, c) => n + c.px, 0),
			// The four band layers alone; the tail's compact backing is read apart.
			bandBackingPx: [...pane.querySelectorAll("canvas")].filter(c => c !== (overlay as any).tailCanvas)
				.reduce((n, c) => n + (c as HTMLCanvasElement).width * (c as HTMLCanvasElement).height, 0),
			tailBacking: tailBackingInfo(overlay),
			// The four band layers alone: without the live tail and without the wet tile.
			bandLayersBackingPx: [...pane.querySelectorAll("canvas")]
				.filter(c => c !== (overlay as any).tailCanvas && c !== (overlay as any).wetTileCanvas)
				.reduce((n, c) => n + (c as HTMLCanvasElement).width * (c as HTMLCanvasElement).height, 0),
			backingBytes: canvases.reduce((n, c) => n + c.px * 4, 0),
			// The REAL ceiling, read from the shipped constant. It is per
			// canvas, not per surface: `backingScale` trims a single canvas's
			// own layout box against it.
			capPerCanvas: MAX_BACKING_AREA,
			hScrollable: scroller3.scrollWidth > scroller3.clientWidth,
			viewportOwned: !!overlay.viewportLayout,
			offFrames: 0, maxOffBy: 0, endsOff: false, offDetail: [], columnXs: [], samples: 1,
			scrolled: true, sizerCentred: true, detectorProves: 0, probeScale: 0,
			scrollLefts: [], scrollWidths: [], clientWidthsSeen: [], icGranted: true,
			scanNulls: 0, scaleSpread: 0, grantXs: [], grantYs: [], scrollHeights: [],
			pinchPreviewFrames: 0, deferArmedFrames: 0, healedOffBy: 0, lastOffAt: null,
		};
		view.destroy();
		pane.remove();
		return out as any;
	}

	// P1 - WHAT A SCROLL-THEN-DRAW COSTS AT LOW ZOOM ON INFINITE CANVAS.
	//
	// Alan, device build 5c1dfdca: "zooming to 10% and then scrolling right and
	// quickly drawing and then scrolling right and then quickly drawing makes
	// lag really really bad", and worse the more the sequence repeats. The
	// sequence IS the measurement: scroll right, commit a stroke, three times.
	//
	// THE SCROLL PHASE AND THE DRAW PHASE ARE COUNTED APART. A cost carried by
	// the grant and a cost carried by the draw want different fixes, and one
	// per-round total cannot tell them apart.
	//
	// THE EXTENT STARTS SMALL, which is the whole difference from the first
	// version of this arm. That one pre-granted 114822 x 65483 - Alan's entire
	// note - so no scroll ever reached virgin surface, ScrollExpansionDemand
	// never reserved, and every counter read zero BY CONSTRUCTION rather than
	// because nothing happened. The grant below is only large enough to make
	// scrollLeft live at all (the host is counter-sized to about 14000 layout
	// px at 0.1 and x cannot scroll until the surface exceeds it); the rounds
	// then scroll PAST it, into the surface the setting has to invent.
	//
	// PER GRANT, NOT SUMMED. Many cheap grants and a few expensive ones are
	// different defects - one wants the grant path throttled, the other wants a
	// single grant made cheaper - and a sum hides which one is here.
	if (isLag(plant)) {
		// TWO KNOBS ON THE SAME SEQUENCE, so a difference between two of these
		// arms has exactly one cause. `dense` changes only points per stroke;
		// `fling` changes only how the round's scroll distance is delivered.
		const dense = plant === "lagDense" || plant === "lagFlingDense";
		const fling = plant === "lagFling" || plant === "lagFlingDense" || plant === "lagCreep";
		const flingFrames = lagOptions?.frames ?? FLING_EVENTS;
		const pointsPer = dense ? LAG_POINTS_DENSE : LAG_POINTS_SPARSE;
		// CREEP: the same 30 events, each one short enough to stay inside the
		// band's margin. The band design says a scroll that does not move the
		// band costs nothing; this is the control that says whether that holds -
		// and therefore whether the fling's 30 whole-world repaints are caused
		// by the band being re-pinned rather than by the scroll itself.
		const creep = plant === "lagCreep";
		const r3 = (n: number) => Math.round(n * 1000) / 1000;
		const proto = Object.getPrototypeOf(overlay);
		const realRepaint = proto.repaint;
		const realResize = proto.handleResize;
		const realExtent = proto.updateExtent;
		const realSchedule = proto.scheduleRepaint;
		const realSyncBand = proto.syncBand;
		// WHAT THE BAND DID, per frame. `repaint` upgrades to a whole-world
		// redraw when the CAMERA moved, and the camera is derived from the
		// band's rect - so "none/moved/resized" beside the camera it left behind
		// is what says whether the cost is caused by the reposition or merely
		// correlated with the scroll.
		// OUTERMOST WORK, for attributing a long frame. Nested patched calls
		// (repaint -> handleResize) are counted once, at the outer call.
		let workDepth = 0, workMs = 0;
		const timed = <T,>(run: () => T): T => {
			const t = workDepth++ === 0 ? performance.now() : 0;
			try { return run(); } finally { if (--workDepth === 0) workMs += performance.now() - t; }
		};
		const bandOutcomes: string[] = [];
		proto.syncBand = function patchedBand(this: unknown, ...a: unknown[]) {
			const out = realSyncBand.apply(this, a);
			bandOutcomes.push(String(out));
			return out;
		};
		// THE CAMERA ORIGIN, per adopted syncCamera (U1/U2, far extent). The
		// stabilizer's cap is absolute - 1/1024 displayed CSS px - while rect
		// rounding may grow with the coordinate magnitude, so the raw input is
		// read here rather than inferred from redraw counts. `canonicalCameraY`
		// is wrapped when it exists (d9be8beb onward) to read the exact raw value
		// and the retained reference it compares against; before that fix raw
		// IS the camera y. The rect terms raw is built from are the stashes
		// syncCamera itself writes in the same synchronous block.
		const realSyncCamera = proto.syncCamera;
		const realCanonicalY = proto.canonicalCameraY as ((raw: number, adopt: boolean) => number) | undefined;
		const realOwnedLeft = proto.ownedColumnLayoutLeft;
		let ownedNull = 0, ownedValue = 0;
		proto.ownedColumnLayoutLeft = function patchedOwnedLeft(this: unknown, ...a: unknown[]) {
			const out = realOwnedLeft.apply(this, a);
			if (out === null) ownedNull++; else ownedValue++;
			return out;
		};
		let canon: { raw: number; prior: number | null; returned: number; backing: number } | null = null;
		if (realCanonicalY) proto.canonicalCameraY = function patchedCanonical(this: any, raw: number, adopt: boolean) {
			const prior = this.cameraOriginY ? this.cameraOriginY.y as number : null;
			const out = realCanonicalY.call(this, raw, adopt);
			if (adopt) {
				const canvases = [this.committedCanvas, this.highlightCanvas, this.wetCanvas, this.highlightWetCanvas, this.tailCanvas];
				const backing = Math.max(...canvases.map((c: HTMLCanvasElement | null) => c ? Math.max(c.width / this.cssWidth, c.height / this.cssHeight) : NaN));
				canon = { raw, prior, returned: out, backing };
			}
			return out;
		};
		type CamSample = { camX: number; camY: number; raw: number; prior: number | null; backing: number | null; cssScale: number; fontZoom: number;
			panX: number; panY: number; rasterPanY: number; overlayTop: number; overlayLeft: number; docTop: number; contentLeft: number; scrollTop: number; scrollLeft: number;
			bandTop: number; bandLeft: number; ownedNull: boolean; gen: number; diff: string };
		const camSamples: CamSample[] = [];
		// The previous adopted sample across phase resets, so the first sync of a
		// draw phase can still say which basis term moved.
		let lastCam: CamSample | null = null;
		let inSync = false, setArgs: number[] | null = null, syncMs = 0;
		proto.syncCamera = function patchedSyncCamera(this: any, ...a: unknown[]) {
			if (this.camera && !Object.prototype.hasOwnProperty.call(this.camera, "setState")) {
				const cam = this.camera, realSet = cam.setState;
				cam.setState = function probeSetState(this: unknown, ...s: number[]) {
					if (inSync) setArgs = s;
					return realSet.apply(this, s);
				};
			}
			canon = null; setArgs = null;
			const nullBefore = ownedNull;
			inSync = true;
			let out: unknown;
			const tSync = performance.now();
			try { out = timed(() => realSyncCamera.apply(this, a)); } finally { inSync = false; syncMs += performance.now() - tSync; }
			if (setArgs) {
				const [camX, camY] = setArgs as number[];
				const c = canon as { raw: number; prior: number | null; returned: number; backing: number } | null;
				const sample: CamSample = { camX: camX!, camY: camY!, raw: c ? c.raw : camY!, prior: c ? c.prior : null, backing: c ? c.backing : null,
					cssScale: this.cssScale, fontZoom: this.fontZoom, panX: this.panX(), panY: this.panY(), rasterPanY: this.rasterPan?.y ?? 0,
					overlayTop: this.lastSyncRectTop, overlayLeft: this.lastSyncRectLeft, docTop: this.lastSyncDocumentTop + this.panY(),
					contentLeft: this.lastSyncContentLeft, scrollTop: this.lastSyncScrollTop, scrollLeft: this.lastSyncScrollLeft,
					bandTop: this.band?.top ?? NaN, bandLeft: this.band?.left ?? NaN, ownedNull: ownedNull > nullBefore, gen: this.viewportGeneration, diff: "" };
				const q = lastCam;
				sample.diff = q ? ((["bandTop", "bandLeft", "cssScale", "fontZoom", "panX", "panY", "rasterPanY", "gen"] as const).filter(n => q[n] !== sample[n]).map(n => `${n}:${q[n]}->${sample[n]}`).join(",") || "unlisted") : "first";
				lastCam = sample;
				camSamples.push(sample);
			}
			return out;
		};
		const CAP = 1 / 1024;
		// Consecutive adopted samples in one raster basis. A band move, a scale
		// or pan change legitimately moves the origin, so only pairs where none
		// of those moved are wobble.
		const camStats = (list: CamSample[]) => {
			let pairs = 0, overCapPrior = 0, withPrior = 0, maxPrior = 0, maxFrame = 0, yChanges = 0, xChanges = 0, maxX = 0;
			let maxOverlayErr = 0, maxDocErr = 0, maxOverlayLeftErr = 0, maxContentLeftErr = 0, overCapFrame = 0;
			const worst: unknown[] = [];
			let basisResets = 0;
			const resetTerms: string[] = [];
			for (let i = 0; i < list.length; i++) {
				const s = list[i]!, k = s.cssScale * s.fontZoom;
				// Raw adopted although it sat inside both caps: the basis changed
				// (or the geometry was invalid), not the cap.
				if (s.prior !== null && s.raw !== s.prior && s.camY === s.raw && s.backing !== null &&
					Math.abs(s.raw - s.prior) * k <= CAP && Math.abs(s.raw - s.prior) * s.fontZoom * s.backing <= 1 / 64) {
					basisResets++;
					if (resetTerms.length < 4) resetTerms.push(s.diff);
				}
				const p = list[i - 1];
				if (!p || p.bandTop !== s.bandTop || p.bandLeft !== s.bandLeft || p.cssScale !== s.cssScale || p.fontZoom !== s.fontZoom ||
					p.panX !== s.panX || p.panY !== s.panY || p.rasterPanY !== s.rasterPanY) continue;
				pairs++;
				// The stabilizer's own comparison, on pairs where nothing that
				// legitimately moves the origin moved.
				if (s.prior !== null) {
					withPrior++;
					const d = Math.abs(s.raw - s.prior) * k;
					maxPrior = Math.max(maxPrior, d);
					if (d > CAP) overCapPrior++;
				}
				const frameD = Math.abs(s.raw - p.raw) * k;
				maxFrame = Math.max(maxFrame, frameD);
				if (frameD > CAP) { overCapFrame++; if (worst.length < 4) worst.push({ frameD, dOverlayTop: s.overlayTop - p.overlayTop, dDocTop: s.docTop - p.docTop, dScrollTop: s.scrollTop - p.scrollTop, overlayTop: s.overlayTop, docTop: s.docTop, scrollTop: s.scrollTop }); }
				if (s.camY !== p.camY) yChanges++;
				if (s.camX !== p.camX) { xChanges++; maxX = Math.max(maxX, Math.abs(s.camX - p.camX) * k); }
				// Each rect against the scroll it should have followed exactly.
				const ideal = (s.scrollTop - p.scrollTop) * s.cssScale, idealX = (s.scrollLeft - p.scrollLeft) * s.cssScale;
				maxOverlayErr = Math.max(maxOverlayErr, Math.abs(s.overlayTop - p.overlayTop + ideal));
				maxDocErr = Math.max(maxDocErr, Math.abs(s.docTop - p.docTop + ideal));
				maxOverlayLeftErr = Math.max(maxOverlayLeftErr, Math.abs(s.overlayLeft - p.overlayLeft + idealX));
				maxContentLeftErr = Math.max(maxContentLeftErr, Math.abs(s.contentLeft - p.contentLeft + idealX));
			}
			const last = list.at(-1);
			return { syncs: list.length, pairs, cap: CAP, withPrior, maxPriorDeltaVisual: maxPrior, overCapPrior, maxFrameDeltaVisual: maxFrame, overCapFrame,
				cameraYChangesSameBasis: yChanges, cameraXChangesSameBasis: xChanges, maxXDeltaVisual: maxX, basisResets, resetTerms,
				maxOverlayTopErr: maxOverlayErr, maxDocTopErr: maxDocErr, maxOverlayLeftErr, maxContentLeftErr,
				ownedNullSyncs: list.filter(x => x.ownedNull).length, worst,
				at: last ? { docTop: last.docTop, overlayTop: last.overlayTop, scrollTop: last.scrollTop, scrollLeft: last.scrollLeft, backing: last.backing, cssScale: last.cssScale } : null };
		};
		// QUEUED vs DRAWN. `scheduleRepaint` latches `repaintQueued` and asks for
		// one animation frame, so several asks inside one frame FOLD into a
		// single repaint. During a fling that folding is the only thing standing
		// between 30 scroll events and 30 whole-world rasterisations, and a count
		// of repaints alone cannot say whether it happened.
		let scheduled = 0;
		proto.scheduleRepaint = function patchedSchedule(this: unknown, ...a: unknown[]) {
			scheduled++;
			return realSchedule.apply(this, a);
		};
		let resizes = 0, resizeMs = 0;
		proto.handleResize = function patchedResize(this: unknown, ...a: unknown[]) {
			resizes++;
			const t = performance.now();
			try { return timed(() => realResize.apply(this, a)); } finally { resizeMs += performance.now() - t; }
		};
		const realCommitScale = proto.commitCameraScale;
		let commitScaleCalls = 0, commitScaleMs = 0;
		proto.commitCameraScale = function patchedCommitScale(this: unknown, ...a: unknown[]) {
			commitScaleCalls++;
			const t = performance.now();
			try { return timed(() => realCommitScale.apply(this, a)); } finally { commitScaleMs += performance.now() - t; }
		};
		const ledger = (overlay as any).damage;
		const realTake = ledger.take.bind(ledger);
		let takes = 0;
		let ledgerWork: string = "none";
		ledger.take = () => {
			takes++;
			const out = realTake();
			ledgerWork = out === "all" ? "all" : `partial:${(out as unknown[]).length}`;
			return out;
		};
		// THE BRANCH ACTUALLY TAKEN, not the ledger's answer. Reading `take()`
		// alone mislabels the hot case exactly backwards: repaint UPGRADES any
		// camera motion to a whole-world redraw AFTER take() has returned, so a
		// flick reports `partial:0` from the ledger and then rasterises
		// everything. Planting 20 ms in the `work === "all"` arm is what caught
		// it - rounds this instrument labelled partial absorbed the full-branch
		// plant to the millisecond.
		//
		// The upgrade is read off repaint's OWN output rather than recomputed
		// from a copy of its rule: `lastPaintCam` before the call against
		// `lastPaintCam` after it is the same three-field compare repaint
		// makes, on the values repaint itself chose.
		const paints: { work: string; ledger: string; ms: number; at: number; geometry?: unknown }[] = [];
		proto.repaint = function patched(this: any, ...a: unknown[]) {
			const takesBefore = takes;
			const bandBefore = bandOutcomes.length;
			const camBefore = this.lastPaintCam;
			const t = performance.now();
			const out = timed(() => realRepaint.apply(this, a));
			const done = performance.now();
			if (takes === takesBefore) {
				// Returned before rasterising anything - deferred, or handed
				// off to handleResize. Counting these as repaints inflates
				// every total that follows.
				paints.push({ work: "early", ledger: "none", ms: r3(done - t), at: done });
			} else {
				const camAfter = this.lastPaintCam;
				const moved = camBefore === null || !camAfter
					|| camBefore.x !== camAfter.x || camBefore.y !== camAfter.y || camBefore.zoom !== camAfter.zoom;
				paints.push({ work: moved ? "all" : ledgerWork, ledger: ledgerWork, ms: r3(done - t), at: done,
					geometry: moved && bandOutcomes.slice(bandBefore).every(x=>x==='none') ? { before:camBefore,after:camAfter,scale:this.scale,pan:{...this.viewportPan},band:{...this.band},scroll:[this.view.scrollDOM.scrollLeft,this.view.scrollDOM.scrollTop],rect:[this.lastSyncRectLeft,this.lastSyncRectTop],column:this.lastSyncContentLeft,top:this.lastSyncDocumentTop,rawColumn:contentOriginLeft(this.view.contentDOM) } : undefined });
			}
			return out;
		};
		// EVERY updateExtent PASS IS TIMED, and the ones that actually granted
		// are kept individually. The pass forces layout whether it grants or
		// not - two getBoundingClientRect, the origin scan, the spacer writes -
		// so the passes that grant NOTHING are their own number.
		const grants: { ms: number; dx: number; dy: number; spacer: boolean }[] = [];
		let extentCalls = 0;
		let extentMs = 0;
		let spacerOnly = 0;
		proto.updateExtent = function patchedExtent(this: any, ...a: unknown[]) {
			extentCalls++;
			const before = surfaceExtents.get(rig.path);
			const sl = this.spacerLeft;
			const st = this.spacerTop;
			const t = performance.now();
			const out = timed(() => realExtent.apply(this, a));
			const ms = performance.now() - t;
			extentMs += ms;
			const after = surfaceExtents.get(rig.path);
			const moved = this.spacerLeft !== sl || this.spacerTop !== st;
			if (after.x !== before.x || after.y !== before.y) {
				grants.push({ ms: r3(ms), dx: after.x - before.x, dy: after.y - before.y, spacer: moved });
			} else if (moved) {
				spacerOnly++;
			}
			return out;
		};
		// SELF-TEST BEFORE ANY NUMBER IS BELIEVED. Three instruments today have
		// reported a confident zero while intercepting nothing; a zero from an
		// unproven patch is silence, not a measurement. All three patches are
		// proven, not just the two the first version proved.
		const probeBefore = paints.length;
		const resizeBefore = resizes;
		const extentBefore = extentCalls;
		const scheduleBefore = scheduled;
		const bandBefore = bandOutcomes.length;
		(overlay as any).repaint();
		(overlay as any).handleResize();
		(overlay as any).updateExtent(true);
		(overlay as any).scheduleRepaint("self-test");
		const selfTest = {
			repaintSeen: paints.length > probeBefore,
			resizeSeen: resizes > resizeBefore,
			extentSeen: extentCalls > extentBefore,
			scheduleSeen: scheduled > scheduleBefore,
			bandSeen: bandOutcomes.length > bandBefore,
		};

		const bytes = () => [...pane.querySelectorAll("canvas")]
			.reduce((n, c) => n + (c as HTMLCanvasElement).width * (c as HTMLCanvasElement).height * 4, 0);
		let peakBytes = bytes();
		const reset = () => {
			paints.length = 0;
			grants.length = 0;
			resizes = 0;
			extentCalls = 0;
			extentMs = 0;
			spacerOnly = 0;
			scheduled = 0;
			bandOutcomes.length = 0;
			camSamples.length = 0;
			ownedNull = 0;
			ownedValue = 0;
			resizeMs = 0;
			commitScaleCalls = 0;
			commitScaleMs = 0;
			syncMs = 0;
			workMs = 0;
		};
		const phase = (reallocBefore: number) => {
			peakBytes = Math.max(peakBytes, bytes());
			return {
				bandMoved: bandOutcomes.filter(x => x === "moved").length,
				bandResized: bandOutcomes.filter(x => x === "resized").length,
				bandStill: bandOutcomes.filter(x => x === "none").length,
				scheduled,
				// Asks that never became their own rasterisation. Negative is
				// impossible; zero means every ask was paid for in full.
				folded: scheduled - paints.filter(x => x.work !== "early").length,
				repaints: paints.filter(x => x.work !== "early").length,
				full: paints.filter(x => x.work === "all").length,
				partial: paints.filter(x => x.work.startsWith("partial")).length,
				early: paints.filter(x => x.work === "early").length,
				paintMs: r3(paints.reduce((n, x) => n + x.ms, 0)),
				paintMsMax: paints.length ? Math.max(...paints.map(x => x.ms)) : 0,
				// branch/ledger:ms - both labels, because they disagree on
				// exactly the frames that carry the cost.
				paintEach: paints.map(x => `${x.work}/${x.ledger}:${x.ms}`),
				cameraChangesWithoutBand:paints.filter(x=>x.geometry).map(x=>x.geometry),
				handleResizes: resizes,
				reallocs: inkCanvasReallocs() - reallocBefore,
				// THE HYPOTHESIS the brief names: a grant reallocates five
				// viewport-sized backings, and at 0.1 the viewport is the whole
				// note - so each scroll right would cost more than the last.
				backingBytes: bytes(),
				extentPasses: extentCalls,
				extentMs: r3(extentMs),
				extentGrants: grants.length,
				grantMs: grants.map(g => g.ms),
				grantDx: grants.map(g => g.dx),
				grantDy: grants.map(g => g.dy),
				spacerMoves: grants.filter(g => g.spacer).length + spacerOnly,
				camera: camStats(camSamples),
				ownedColumn: { nullCalls: ownedNull, valueCalls: ownedValue },
				work: { outerMs: r3(workMs), resizeMs: r3(resizeMs), commitScaleCalls, commitScaleMs: r3(commitScaleMs), syncMs: r3(syncMs) },
			};
		};

		// DENSITY, because a full repaint costs per stroke and this arm had
		// three. `drawCommitted` walks every stroke in the note, and at 0.1 the
		// whole note is on screen, so the cost of that branch scales with the
		// ink Alan actually has. The three-stroke version of this arm reported
		// a full repaint at 0.3 ms: a true number about a note nobody owns.
		//
		// Injected rather than drawn - 1500 pointer sequences would be 1500
		// commits and 1500 repaints before the measurement began - and spread
		// across the region the rounds scroll through, at the size a pen
		// leaves behind.
		//
		// RESAMPLED ALONG ONE PATH, so density is a knob and not a second
		// fixture: at 4 points this returns LAG_PATH's own vertices, which are
		// the points the first version of this arm injected.
		const alongPath = (u: number): readonly [number, number] => {
			const segs = LAG_PATH.length - 1;
			const i = Math.min(segs - 1, Math.floor(u * segs));
			const f = u * segs - i;
			const a = LAG_PATH[i]!;
			const b = LAG_PATH[i + 1]!;
			return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
		};
		// FAR EXTENT, in the px Alan sees. The 1200-px arm and a far arm differ in
		// the coordinate magnitude and nothing else: the ink, the extent and the
		// scroll position all shift by the same note distance, so the viewport sees
		// the same dense ink at 11482 visual px that it sees at 1200.
		const farVisual = lagOptions?.far ? (lagOptions.farVisual ?? 1200) : 0;
		const farShift = lagOptions?.farVisual ? (lagOptions.farVisual - 1200) / pinch : 0;
		const ink: unknown[] = [];
		for (let k = 0; k < LAG_STROKES; k++) {
			const ox = (k * 977) % 55000 + farShift;
			const oy = (k * 613) % (lagOptions ? 55000 : 18000) + farShift;
			const pts = Array.from({ length: pointsPer }, (_, j) => {
				const [dx, dy] = alongPath(j / (pointsPer - 1));
				return { x: ox + dx, y: oy + dy, pressure: 0.5, t: j * 8 };
			});
			ink.push({
				id: `lag-${k}`, tool: "pen", color: "#222", width: 2, points: pts,
				bbox: { x: ox - 2, y: oy - 2, width: 31, height: 11 }, createdAt: 1,
			});
		}
		inlineInk.applyAdd(rig.path, ink as never);
		const scroller2 = view.scrollDOM;
		// ROOM FOR ALL THREE FLICKS, and no more. 20000 was tried first - just
		// past the counter-sized host, so the first flick would hit the frontier
		// and the setting would have to invent the rest. It could not: measured,
		// `ScrollExpansionDemand` granted nothing across the whole sequence, so
		// scrollLeft clamped at 6842 on round 0 and rounds 1 and 2 scrolled
		// nowhere at all - three rounds of which two were dead. The reason is in
		// `handleResize`, which calls `rebase` unconditionally: a flick that
		// changes the band's size reaches `handleResize` through repaint's
		// `syncBand() === "resized"` arm, and `rebase` then sets `left` to where
		// the flick just landed and clears both pending latches - erasing the
		// demand raised by the very scroll that caused the resize. That is P2's
		// question ("i cannot scroll right until i toggle infinite canvas"), not
		// this one, and it is recorded here rather than chased.
		//
		// 60000 is still far short of Alan's 114822 and leaves the rounds
		// scrolling through surface, which is what the cost question needs.
		surfaceExtents.grow(rig.path, { x: 60000 + farShift, y: (lagOptions ? 60000 : 20000) + farShift });
		(overlay as any).updateExtent(true);
		await settle(10);
		if (lagOptions?.far) {
			scroller2.scrollLeft = farVisual / pinch;
			scroller2.scrollTop = farVisual / pinch;
			await settle(10);
		}
		// Where the far arm really landed, before any round moves it. A clamped
		// write would measure the near arm under a far label.
		// HOST CSS REALLY LOADED: the leaf shell exists and a variable only the
		// app stylesheet declares resolves.
		const hostProof = { shell: !!pane.closest(".workspace-leaf"), appCssVar: getComputedStyle(document.body).getPropertyValue("--cursor").trim() };
		const farReached = { scrollLeft: scroller2.scrollLeft, scrollTop: scroller2.scrollTop, visualLeft: scroller2.scrollLeft * pinch, visualTop: scroller2.scrollTop * pinch,
			scrollWidth: scroller2.scrollWidth, scrollHeight: scroller2.scrollHeight, contentTop: view.contentDOM.getBoundingClientRect().top };
		// 900 px AS ALAN SEES THEM. The host is counter-sized by 1/pinch, so a
		// 900-px flick on screen is 900/pinch of scrollLeft; using 900 raw
		// would be a 90-px nudge at 0.1 and would never reach any frontier.
		const step = Math.round(900 / pinch);
		const rounds: unknown[] = [];
		const initialInk = lagOptions ? JSON.stringify(inlineInk.strokes(rig.path)) : "";
		const initialCount = inlineInk.strokes(rig.path).length;
		const distance = lagOptions?.distance ?? (lagOptions?.routed ? 360 : 900);
		const pr = pane.getBoundingClientRect();
		const endpointPixels = (canvas: HTMLCanvasElement, x: number, y: number, red: number) => {
			const r = canvas.getBoundingClientRect(), sx = canvas.width/r.width, sy = canvas.height/r.height;
			if (x-5<r.left || x+5>r.right || y-5<r.top || y+5>r.bottom) return 0;
			const data = canvas.getContext("2d")!.getImageData(Math.floor((x-r.left-5)*sx), Math.floor((y-r.top-5)*sy), Math.ceil(10*sx), Math.ceil(10*sy)).data;
			let count = 0;
			for(let j=0;j<data.length;j+=4) if(data[j+3]!>20 && Math.abs(data[j]!-red)<5 && data[j+1]!<5 && data[j+2]!>250) count++;
			return count;
		};
		const touch = (type: string, x: number, y: number) => {
			const target = document.elementFromPoint(x, y);
			if (!target || !scroller2.contains(target)) throw new Error(`touch misses scroller: ${x},${y}`);
			target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 811,
				isPrimary: true, clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1, width: 8, height: 8 }));
		};
		for (let i = 0; i < 3; i++) {
			// ---- the flick -------------------------------------------------
			reset();
			const reallocScroll = inkCanvasReallocs();
			const tScroll = performance.now();
			// FRAME GAPS ARE THE SYMPTOM. Repaint ms says what the rasteriser
			// spent; the gap between one animation frame and the next says what
			// Alan saw. They differ whenever work lands outside the patched
			// method, and only the second one is "lag".
			const gaps: number[] = [];
			const input: unknown[] = [];
			if (fling) {
				// One scroll event per animation frame, covering the SAME total
				// distance as the single-event arm, so the two differ in
				// delivery and in nothing else.
				// The creep control is the one exception to "same distance,
				// different delivery": it keeps the per-event distance well
				// under the band's margin, which is the whole point of it.
				const per = creep ? CREEP_PX_PER_EVENT : (lagOptions ? distance / pinch : step) / flingFrames;
				let carried = 0;
				let tGap = performance.now();
				const sx = pr.left + 700, sy = pr.top + 600;
				if (lagOptions?.routed) touch("pointerdown", sx, sy);
				for (let f = 0; f < flingFrames; f++) {
					carried += per;
					const whole = Math.floor(carried);
					carried -= whole;
					const before = [scroller2.scrollLeft, scroller2.scrollTop];
					const tInput = performance.now();
					if (lagOptions?.routed) {
						const travel = (f + 1) * distance / flingFrames;
						touch("pointermove", sx - (lagOptions.axis === "y" ? 0 : travel), sy - (lagOptions.axis === "x" ? 0 : travel));
					} else {
						if (lagOptions?.axis !== "y") scroller2.scrollLeft += whole;
						if (lagOptions && lagOptions.axis !== "x") scroller2.scrollTop += whole;
						scroller2.dispatchEvent(new Event("scroll", { bubbles: true }));
					}
					if (lagOptions) input.push({ before, after: [scroller2.scrollLeft, scroller2.scrollTop], ms: performance.now() - tInput,
						assist: overlay.router.assistEngaged, parole: overlay.router.paroleId });
					await frame();
					const now = performance.now();
					gaps.push(r3(now - tGap));
					tGap = now;
				}
				if (lagOptions?.routed) touch("pointerup", sx - (lagOptions.axis === "y" ? 0 : distance), sy - (lagOptions.axis === "x" ? 0 : distance));
			} else {
				scroller2.scrollLeft += step;
				scroller2.dispatchEvent(new Event("scroll", { bubbles: true }));
				// ONE FRAME, not eight. "Scrolling right and QUICKLY drawing" is
				// the complaint, and a settle here removes the overlap it names:
				// the pen lands while the band resize, the reallocation and the
				// full repaint the flick caused are still in flight. Settling
				// first hands the draw a quiet surface and measures a sequence
				// Alan never performs. The phases stay split so the cost is
				// still attributable - whatever the flick has not paid for by
				// this frame is charged to the draw.
				await settle(1);
			}
			const scrollPhase = {
				...phase(reallocScroll),
				at: tScroll,
				wallMs: r3(performance.now() - tScroll),
				// The fling's own shape: how long each frame took to come back.
				gapMax: gaps.length ? Math.max(...gaps) : 0,
				gapsOver32: gaps.filter(g => g > 32).length,
				gaps,
				input,
			};
			// ---- the stroke ------------------------------------------------
			reset();
			const reallocDraw = inkCanvasReallocs();
			const beforeDrawCount = inlineInk.strokes(rig.path).length;
			if (lagOptions?.pixels) pickStripColor("Probe", `#${(i*60).toString(16).padStart(2,"0")}00ff`);
			const x = Math.round(pr.left + 200 + i * 20), y = Math.round(pr.top + 300);
			let wetPixels: number | null = null;
			let tailPixels: number | null = null;
			const penSamples: { type: string; time: number }[] = [];
			const tDraw = performance.now();
			const commitMs = drawAtTimed(view, x, y, 120 + i, lagOptions?.pixels ? () => {
				// The smoothed ribbon deliberately trails the newest sample;
				// its live raw head is drawn synchronously on the tail canvas.
				wetPixels = endpointPixels(overlay.wetCanvas, x+120, y-10, i*60);
				tailPixels = endpointPixels(overlay.tailCanvas, x+120, y-10, i*60);
			} : undefined, lagOptions ? penSamples : undefined);
			await settle(lagOptions?.rapid ? 1 : 12);
			const committedPixels = lagOptions?.pixels ? endpointPixels(overlay.committedCanvas, x+120, y-10, i*60) : null;
			const reference = overlay.cameraOriginY;
			const fresh = lagOptions ? overlay.freshFrame() : null;
			const lastPaintAt = paints.length ? paints[paints.length - 1]!.at : 0;
			const drawPhase = {
				...phase(reallocDraw),
				at: tDraw,
				// The synchronous cost of pen-up itself: drawCommitted writes
				// the committed canvas inside the pointerup dispatch, outside
				// repaint, so counting repaints after pen-up reads zero by
				// construction and this is the number that does not.
				commitMs,
				// Pen-up to the last frame that actually rasterised anything.
				// 0 means nothing repainted after the commit - which is the
				// good case, not a missing measurement.
				presentedMs: lastPaintAt ? r3(lastPaintAt - tDraw) : 0,
				wallMs: r3(performance.now() - tDraw),
			};
			const d = (overlay as any).scrollExpansion;
			rounds.push({
				round: i,
				added: inlineInk.strokes(rig.path).length - beforeDrawCount,
				wetPixels, tailPixels, committedPixels, penSamples,
				acceptedPoints: inlineInk.strokes(rig.path).slice(beforeDrawCount).map(s => s.points.length),
				freshPure: overlay.cameraOriginY === reference,
				freshError: fresh ? Math.abs(fresh.y-overlay.camera.y)*overlay.scale : null,
				// WHY a round granted nothing, when it granted nothing. Demand is a
				// latch pair plus a remembered room, and every one of those can be
				// the reason on its own.
				demand: d ? { rev: d.revision, pendingX: d.pendingX, pendingY: d.pendingY, left: d.left, top: d.top, rebased: d.rebased, roomEdgeX: d.room?.edgeX, roomW: d.room?.width, roomNW: d.room?.nativeWidth, enabled: d.enabled } : null,
				scrollLeft: Math.round(scroller2.scrollLeft),
				scrollTop: Math.round(scroller2.scrollTop),
				scrollWidth: Math.round(scroller2.scrollWidth),
				clientWidth: scroller2.clientWidth,
				granted: { ...surfaceExtents.get(rig.path) },
				peakBackingBytes: peakBytes,
				scroll: scrollPhase,
				draw: drawPhase,
			});
		}
		// G1: DRAW -> ZOOM -> DRAW -> ZOOM, repeated, at the far extent. Alan's
		// second complaint is this loop between 10% and 15%, and nothing above
		// changes the scale. The zoom goes through the router's two-finger path
		// (beginPinch/updatePinch/endPinch with live touch positions), the entry
		// a real pinch reaches after pointer parsing, so the preview frames, the
		// pinch quiet window and the settle commit all run as on the device.
		// commitCameraScale alone would skip every one of those.
		const zoomLoop: unknown[] = [];
		// LONG FRAMES, attributed by the browser rather than by the patches: a
		// frame whose time is not inside any patched plugin method is split by
		// Long Animation Frame timing into script before render, rAF callbacks,
		// and style/layout/paint.
		const longFrames: { start: number; duration: number; beforeRender: number; rafCallbacks: number; styleLayoutPaint: number; scripts: unknown[] }[] = [];
		let loaf: PerformanceObserver | null = null;
		if (lagOptions?.zoomCycles) {
			try {
				loaf = new PerformanceObserver(list => {
					for (const e of list.getEntries() as any[]) {
						if (e.duration < 100) continue;
						const renderStart = e.renderStart || e.startTime + e.duration, layoutStart = e.styleAndLayoutStart || renderStart;
						longFrames.push({ start: r3(e.startTime), duration: r3(e.duration), beforeRender: r3(renderStart - e.startTime), rafCallbacks: r3(layoutStart - renderStart),
							styleLayoutPaint: r3(e.startTime + e.duration - layoutStart),
							scripts: (e.scripts ?? []).map((x: any) => ({ invoker: x.invoker, fn: x.sourceFunctionName, ms: r3(x.duration), forcedLayoutMs: r3(x.forcedStyleAndLayoutDuration ?? 0) })) });
					}
				});
				loaf.observe({ type: "long-animation-frame", buffered: false });
			} catch { loaf = null; }
		}
		if (lagOptions?.zoomCycles) {
			const router = overlay.router;
			const cx = Math.round(pr.left + 700), cy = Math.round(pr.top + 420);
			const setTouch = (spread: number) => { router.touchPos.set(861, { x: cx - spread / 2, y: cy }); router.touchPos.set(862, { x: cx + spread / 2, y: cy }); };
			const pinchEvent = (type: string) => new PointerEvent(type, { pointerId: 862, pointerType: "touch" });
			const low = pinch, high = pinch === 0.1 ? 0.15 : pinch * 1.5;
			const roundtripNow = () => {
				const live = inlineInk.strokes(rig.path);
				const saved = parsePage(sidecars.get(ids.get(rig.path)!)!, ids.get(rig.path)!).data.strokes;
				return saved.length === live.length && live.every((s, i) => {
					const q = saved[i]!;
					return s.id === q.id && s.points.length === q.points.length && s.points.every((p, j) => Math.abs(p.x - q.points[j]!.x) <= .005001 && Math.abs(p.y - q.points[j]!.y) <= .005001);
				});
			};
			for (let c = 0; c < lagOptions.zoomCycles * 2; c++) {
				// ---- draw at the current scale ------------------------------
				reset();
				const reallocDraw = inkCanvasReallocs();
				const countBefore = inlineInk.strokes(rig.path).length;
				const x = Math.round(pr.left + 200 + (c % 8) * 30), y = Math.round(pr.top + 300 + (c % 3) * 40);
				const tDraw = performance.now();
				const drawGaps: number[] = [];
				const commitMs = drawAtTimed(view, x, y, 400 + c);
				let tGap = performance.now();
				const drawWork: number[] = [];
				let drawWorkAt = workMs;
				for (let f = 0; f < 4; f++) { await frame(); const now = performance.now(); drawGaps.push(r3(now - tGap)); drawWork.push(r3(workMs - drawWorkAt)); drawWorkAt = workMs; tGap = now; }
				const draw = { ...phase(reallocDraw), commitMs, wallMs: r3(performance.now() - tDraw), gaps: drawGaps, drawWork, gapMax: Math.max(...drawGaps) };
				const added = inlineInk.strokes(rig.path).length - countBefore;
				// ---- zoom to the other end of the range ----------------------
				reset();
				const reallocZoom = inkCanvasReallocs();
				const from = overlay.pinchScaleNow as number, to = c % 2 === 0 ? high : low;
				const startSpread = 300, endSpread = startSpread * to / from;
				const tZoom = performance.now();
				const gestureGaps: number[] = [];
				setTouch(startSpread); router.beginPinch(pinchEvent("pointerdown"));
				tGap = performance.now();
				for (let k = 1; k <= 8; k++) {
					setTouch(startSpread + (endSpread - startSpread) * k / 8);
					router.updatePinch(pinchEvent("pointermove"));
					await frame();
					const now = performance.now(); gestureGaps.push(r3(now - tGap)); tGap = now;
				}
				router.endPinch(pinchEvent("pointerup"), { x: cx, y: cy });
				router.touchPos.clear();
				const tEnd = performance.now();
				// SETTLE, frame by frame, long enough to outlast the pinch quiet
				// window several times over. A storm is repaints that keep coming
				// in the LATE half of this window, after the commit has landed.
				const settleGaps: number[] = [];
				tGap = performance.now();
				const settleWork: number[] = [];
				let workAt = workMs;
				while (performance.now() - tEnd < 700) { await frame(); const now = performance.now(); settleGaps.push(r3(now - tGap)); settleWork.push(r3(workMs - workAt)); workAt = workMs; tGap = now; }
				const lateFrom = tEnd + 350;
				const late = paints.filter(p => p.at >= lateFrom && p.work !== "early");
				await new Promise(res => setTimeout(res, 0));
				const zoom = { ...phase(reallocZoom), from, to, settled: overlay.pinchScaleNow, cssScale: overlay.cssScale, wallMs: r3(performance.now() - tZoom),
					gestureGaps, settleGaps, settleWork, gapMax: Math.max(...gestureGaps, ...settleGaps), gapsOver32: [...gestureGaps, ...settleGaps].filter(g => g > 32).length,
					lateRepaints: late.length, lateFull: late.filter(p => p.work === "all").length, lateMs: r3(late.reduce((n, p) => n + p.ms, 0)),
					scrollLeft: scroller2.scrollLeft, scrollTop: scroller2.scrollTop, visualTop: scroller2.scrollTop * overlay.cssScale, visualLeft: scroller2.scrollLeft * overlay.cssScale };
				const tRoundtrip = performance.now();
				const roundtrip = roundtripNow();
				const roundtripMs = r3(performance.now() - tRoundtrip);
				await settle(2);
				const cycleFrames = (t0: number, t1: number) => longFrames.filter(f => f.start >= t0 && f.start < t1);
				zoomLoop.push({ drawLongFrames: cycleFrames(tDraw, tZoom), zoomLongFrames: cycleFrames(tZoom, tRoundtrip), cycle: c, scaleAtDraw: from, added, stored: inlineInk.strokes(rig.path).length, roundtrip, roundtripMs, backingBytes: bytes(), draw, zoom });
			}
		}
		loaf?.disconnect();
		// A real, fractional layout change must still move the raster origin.
		// Read the text and ink independently in the browser's visual frame.
		const reflow: { error: number; origin: number }[] = [];
		if (lagOptions) {
			const observeOrigin = () => {
				const content = view.contentDOM.getBoundingClientRect();
				const top = content.top + parseFloat(getComputedStyle(view.contentDOM).paddingTop) * view.scaleY;
				const inkTop = overlay.inkLayer.getBoundingClientRect().top - overlay.lastPaintCam.y * overlay.scale;
				reflow.push({ error: Math.abs(top - inkTop), origin: top / overlay.cssScale + scroller2.scrollTop });
			};
			observeOrigin();
			sizer.style.marginTop = "1.25px";
			view.requestMeasure();
			await settle(8);
			// Explicitly measure an otherwise unobserved position-only change.
			// This control tests camera adoption, not observer delivery.
			overlay.scheduleRepaint("scroll"); await settle(2);
			observeOrigin();
			sizer.style.marginTop = "0px";
			view.requestMeasure();
			await settle(8);
			overlay.scheduleRepaint("scroll"); await settle(2);
			observeOrigin();
		}
		proto.repaint = realRepaint;
		proto.handleResize = realResize;
		proto.updateExtent = realExtent;
		proto.scheduleRepaint = realSchedule;
		proto.syncBand = realSyncBand;
		proto.syncCamera = realSyncCamera;
		proto.commitCameraScale = realCommitScale;
		proto.ownedColumnLayoutLeft = realOwnedLeft;
		if (realCanonicalY) proto.canonicalCameraY = realCanonicalY;
		if (Object.prototype.hasOwnProperty.call(overlay.camera, "setState")) delete overlay.camera.setState;
		z10?.stop();
		ledger.take = realTake;
		const strokes2 = inlineInk.strokes(rig.path).length;
		const live = inlineInk.strokes(rig.path);
		const saved = lagOptions ? parsePage(sidecars.get(ids.get(rig.path)!)!, ids.get(rig.path)!).data.strokes : [];
		const quality = lagOptions ? {
			originalUnchanged: JSON.stringify(live.slice(0, initialCount)) === initialInk,
			savedCount: saved.length,
			roundtrip: saved.length === live.length && live.every((s, i) => {
				const q = saved[i]!;
				return s.id === q.id && s.tool === q.tool && s.color === q.color && Math.abs(s.width - q.width) <= .000501 && s.points.length === q.points.length && s.points.every((p, j) => {
					const v = q.points[j]!;
					return Math.abs(p.x-v.x)<=.005001 && Math.abs(p.y-v.y)<=.005001 && Math.abs(p.pressure-v.pressure)<=.000501 && Math.abs(p.t-v.t)<=.500001;
				});
			}),
		} : null;
		view.destroy();
		pane.remove();
		return { z10: z10 ? { installedAt: z10.installedAt, rows: z10.rows, twin: z10.twin, refusalLog: z10.refusalLog, measureCalls: z10.measureCalls } : undefined, readable, plant, pinch, lagOptions, strokes: strokes2, rounds, selfTest, step, injected: LAG_STROKES, quality, reflow, farReached, zoomLoop, hostProof, longFrames, loafSupported: typeof PerformanceObserver !== "undefined" && (PerformanceObserver.supportedEntryTypes ?? []).includes("long-animation-frame"), stabilizerPresent: !!realCanonicalY,
			pointsPer, points: LAG_STROKES * pointsPer, fling, flingEvents: fling ? flingFrames : 1,
			hScrollable: true, offFrames: 0, maxOffBy: 0, endsOff: false, offDetail: [],
			columnXs: [], samples: 0, scrolled: true, sizerCentred: true, detectorProves: 0,
			probeScale: 0, scrollLefts: [], scrollWidths: [], clientWidthsSeen: [],
			icGranted: true, scanNulls: 0, scaleSpread: 0, grantXs: [], grantYs: [],
			scrollHeights: [], overflowXs: [], axisClasses: [], hscrollClasses: [],
			pinchPreviewFrames: 0, deferArmedFrames: 0 } as any;
	}

	const t0 = performance.now();
	const samples: Sample[] = [sample(overlay, view, sizer, t0)];
	const plantedAt: number[] = [];

	for (let step = 0; step < 6; step++) {
		// `hscroll` moves the horizontal axis DURING the vertical scroll, both
		// directions, which is what Alan describes ("moves sideways left
		// right"). A vertical scroll does not move scrollLeft by itself in this
		// fixture, so if the band's left - which `bandFor` computes FROM
		// scrollLeft - can displace committed ink, this is the state that shows
		// it. Both directions on purpose: a one-way recentre would only ever
		// slide one way.
		// TWO-FINGER PAN. On a touch surface a sustained two-finger gesture
		// delivers pinch("move", ...) every frame even when the spread - and so
		// the scale - is unchanged. InkOverlay:4629-4631 takes that branch
		// UNCONDITIONALLY: it sets pinchPreview = true and re-stamps
		// pinchScrollAt on every such event. While that 120ms window is armed,
		// deferPinchRaster() makes BOTH repaint() and syncCamera() return
		// immediately, and the scroll listener returns before scheduleRepaint -
		// yet setViewportScroll still moves the scroller. Content moves, camera
		// frozen, band never resynced.
		if (plant === "twofinger") {
			const pr = pane.getBoundingClientRect();
			const f = { x: Math.round(pr.left + pr.width / 2), y: Math.round(pr.top + pr.height / 2) };
			overlay.pinch("move", overlay.pinchScaleNow, f);
		}
		// A real two-finger pan moves BOTH axes. A purely vertical one cannot
		// show this fault even if it is there: with the column screen-fixed,
		// "ink x vs column x" has nothing to differ about. The suppression has
		// to be armed while x is actually moving.
		if (plant === "hscroll" || plant === "twofinger") {
			scroller.scrollLeft += step % 2 === 0 ? 400 : -260;
		}
		if (step === 3) {
			// Both plants change where the column sits WITHOUT changing any
			// line's size and without resizing `.cm-editor` - the blind spot
			// the field comment describes.
			if (plant === "scrollbar") {
				// A classic vertical scrollbar takes width off the scroller's
				// CONTENT box, which is what `padding-right` reproduces exactly.
				// `overflow-y: scroll` was tried first and is inert here:
				// headless Chromium uses overlay scrollbars, so clientWidth
				// never moved (measured [1400] before and after).
				//
				// THIS IS THE BLIND SPOT, and the two properties that make it
				// one: the sizer is `width:100%` capped at 700px, so it stays
				// 700px wide and only its auto margins change - the column
				// slides LEFT by half the scrollbar. No `.cm-line` resizes, so
				// `originLineObserver` is silent; `.cm-editor`'s own box does
				// not change, so `handleResize`'s origin compare is silent too.
				scroller.style.paddingRight = "15px";
			} else if (plant === "recentre") {
				// The cap itself changing. NOT the blind spot: this also caps
				// `.cm-line`, so the lines really do resize and
				// `originLineObserver` fires. Kept as the control that proves
				// the correction path works when something does fire.
				document.body.style.setProperty("--file-line-width", "500px");
			}
			plantedAt.push(step);
		}
		scroller.scrollTop += 240;
		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
		for (let f = 0; f < FRAMES_PER_STEP; f++) {
			// Keep the gesture alive across frames, as a real finger does.
			if (plant === "twofinger" && f < 6) {
				const pr = pane.getBoundingClientRect();
				overlay.pinch("move", overlay.pinchScaleNow, { x: Math.round(pr.left + pr.width / 2), y: Math.round(pr.top + pr.height / 2) });
			}
			await frame();
			samples.push(sample(overlay, view, sizer, t0));
		}
	}
	await settle(12);
	samples.push(sample(overlay, view, sizer, t0));

	// POSITIVE CONTROL FOR THE DETECTOR ITSELF.
	//
	// Every arm above reported 0.00, and a detector that has never once
	// produced a non-zero cannot be used to refute anything - the same
	// same-frame blindness already caught out an earlier version of this file.
	// So: displace the painted camera by a known 10 note-px and read it back.
	// `offBy` must report -10 * scale. If it reports 0, the zeros above mean
	// "this probe cannot see displacement", not "there is none".
	const probeScale = overlay.scale || 1;
	const painted = overlay.lastPaintCam;
	let detectorProves = 0;
	if (painted) {
		overlay.lastPaintCam = { ...painted, x: painted.x + 10 };
		const poked = sample(overlay, view, sizer, t0);
		detectorProves = poked.offBy === null ? 0 : Math.abs(poked.offBy);
		overlay.lastPaintCam = painted;
	}

	const off = samples.filter(s => s.offBy !== null && Math.abs(s.offBy) > VISIBLE_PX);
	const columnXs = [...new Set(samples.map(s => (s.columnX === null ? "null" : s.columnX.toFixed(2))))];
	const sizerLefts = [...new Set(samples.map(s => Math.round(s.sizerLeft * 100) / 100))];
	const clientWidths = [...new Set(samples.map(s => s.scrollerClientWidth))];

	const result = {
		readable,
		plant,
		pinch,
		pinchNow: overlay.pinchScaleNow,
		viewportOwned: !!overlay.viewportLayout,
		scrollLefts: [...new Set(samples.map(s => Math.round(s.scrollLeft * 100) / 100))],
		scrollWidths: [...new Set(samples.map(s => s.scrollWidth))],
		clientWidthsSeen: [...new Set(samples.map(s => s.scrollerClientWidth))],
		overflowXs: [...new Set(samples.map(s => s.overflowX))],
		axisClasses: [...new Set(samples.map(s => s.axisClass))],
		hscrollClasses: [...new Set(samples.map(s => s.hscrollClass))],
		hScrollable: samples.some(s => s.scrollWidth > s.scrollerClientWidth),
		// COLUMN NOT FOUND. `resolveColumnLeft(null)` falls back to
		// `lastGoodColumnLeft`, which is the shipped code doing exactly what the
		// ablation does by hand - freezing the column. If the scan ever returns
		// null while the column is moving, the symptom follows with no bug
		// anywhere else. Counted so a zero here is a measurement.
		axisPatched: !!overlay.axisGuard?.patched,
		scanNulls: samples.filter(s => s.columnX === null).length,
		// Alan 2026-09-12: only the INK slides, the text does not. That fixes
		// contentLeft as correct, and ink screen x = contentLeft + x0 * scale,
		// so `scale` is the only free term left. Any spread here during a
		// scroll is the fault; a single value exonerates it.
		scales: [...new Set(samples.map(s => s.scale))],
		cssScales: [...new Set(samples.map(s => s.cssScale))],
		fontZooms: [...new Set(samples.map(s => s.fontZoom))],
		scrollHeights: [...new Set(samples.map(s => s.scrollHeight))],
		grantXs: [...new Set(samples.map(s => s.grantX))],
		grantYs: [...new Set(samples.map(s => s.grantY))],
		// LIVENESS for the Infinite Canvas arm: if nothing was ever granted,
		// the machinery never ran and this arm's green means nothing.
		// LIVENESS for the twofinger arm.
		deferArmedFrames: samples.filter(s => s.deferArmed).length,
		pinchPreviewFrames: samples.filter(s => s.pinchPreview).length,
		icGranted: samples.some(s => s.grantX > 0 || s.grantY > 0),
		scaleSpread: Math.max(...samples.map(s => s.scale)) - Math.min(...samples.map(s => s.scale)),
		strokes,
		columnLeftAtStart: colLeft,
		geoBefore,
		geoAfter: geo(),
		samples: samples.length,
		// THE RED CONDITION: frames where ink is not on the column.
		offFrames: off.length,
		maxOffBy: off.length ? Math.max(...off.map(s => Math.abs(s.offBy!))) : 0,
		// Does it heal, and how long does it take?
		lastOffAt: off.length ? off[off.length - 1]!.at : null,
		endsOff: samples[samples.length - 1]!.offBy !== null && Math.abs(samples[samples.length - 1]!.offBy!) > VISIBLE_PX,
		offDetail: off.slice(0, 6),
		columnXs,
		sizerLefts,
		clientWidths,
		plantedAt,
		// Non-zero (about 10 * scale) means the detector can see a displacement
		// at all. Zero voids every other number in this result.
		detectorProves,
		probeScale,
		// Liveness: without these every zero above could be an empty fixture.
		scrolled: samples[samples.length - 1]!.scrollTop > samples[0]!.scrollTop,
		sizerCentred: readable ? sizerLefts.some(l => l > 100) : true,
	};
	view.destroy();
	pane.remove();
	return result;
}

/** Focal ownership, distinct from the existing ink-versus-column oracle.
 * The DOM marker is fixed in content coordinates; no production camera math
 * is used to move it after capture. The router's two-contact scale/midpoint
 * callback is real; touch tracking is seeded to isolate its pinch path.
 */
async function runFocal(readable: boolean, infiniteCanvas: boolean, moving: boolean, scenario: "ordinary" | "negative" | "maximum" | "second" | "lazy" | "delayed" | "takeover" = "ordinary", input?: "reconfigureAll" | "reconfigureAllControl" | "mappedRemove" | "mappedRemoveControl" | "foreignReplace" | "foreignReplaceControl" | "setState" | "setStateControl" | "nonconverging" | "remove" | "recreate" | "removeControl" | "recreateControl" | "scrollReadWrite" | "missing" | "nonfirst" | "postMeasure" | "scrollImmediate" | "wheel" | "pen" | "keyboard" | "zoom" | "switch" | "destroy" | "pinch") {
	const rig = await mount(`focal-${readable}-${infiniteCanvas}-${moving}-${scenario}`, readable, infiniteCanvas, input === "missing" || input === "nonfirst" ? input : undefined);
	let destroyed = false;
	const { pane, view, overlay, path } = rig;
	const scroller = view.scrollDOM;
	if (input?.endsWith('Control')) {
		const dispatch = view.dispatch.bind(view);
		view.dispatch = ((spec: any) => spec?.effects === overlay.panAnchorHold?.issuance ? dispatch({}) : dispatch(spec)) as typeof view.dispatch;
	}
	const pr = pane.getBoundingClientRect();
	drawAt(view, (contentOriginLeft(view.contentDOM) ?? pr.left) + 80, pr.top + 200, 191);
	await settle(8);
	const stroke = inlineInk.strokes(path)[0]!;
	// Genuine synthetic ink bounds provide scroll range; no arbitrary blank
	// expansion is granted to make an otherwise unreachable assertion pass.
	const dx = scenario === "second" ? 40000 : 10000, dy = dx;
	inlineInk.commit(path, { ...stroke, id: stroke.id + '-far', points: stroke.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })), bbox: { ...stroke.bbox, x: stroke.bbox.x + dx, y: stroke.bbox.y + dy } });
	overlay.scheduleRepaint('focal-ink');
	await settle(10);
	if (scenario === "maximum" || scenario === "lazy") { scroller.scrollLeft = scroller.scrollWidth; scroller.scrollTop = scroller.scrollHeight; }
	else if (scenario !== "negative") { scroller.scrollLeft = scenario === "second" ? 12000 : 4000; scroller.scrollTop = scenario === "second" ? 6000 : 2400; }
	await settle(10);
	let focal = { x: pr.left + pr.width * .75, y: pr.top + pr.height * .5 };
	const markerHost = view.contentDOM.parentElement!;
	markerHost.style.position = 'relative';
	const marker = markerHost.appendChild(document.createElement('span'));
	marker.style.cssText = 'position:absolute;width:2px;height:2px;background:red;pointer-events:none';
	const cr = markerHost.getBoundingClientRect();
	marker.style.left = `${focal.x - cr.left}px`;
	marker.style.top = `${focal.y - cr.top}px`;
	const initial = marker.getBoundingClientRect();
	let origin = { x: initial.left, y: initial.top };
	let markerAtLeft = (initial.left - view.dom.getBoundingClientRect().left + scroller.scrollLeft * overlay.cssScale) / overlay.pinchScaleNow;
	let markerAtTop = (initial.top - view.dom.getBoundingClientRect().top + scroller.scrollTop * overlay.cssScale) / overlay.pinchScaleNow;
	const columnAtStart = ((contentOriginLeft(view.contentDOM) ?? NaN) - view.dom.getBoundingClientRect().left) / overlay.cssScale + scroller.scrollLeft;
	const boundaries: unknown[] = [];
	const consumer = overlay.consumeViewportScroll;
	if (consumer) overlay.consumeViewportScroll = function (range: any) {
		const hold = this.panAnchorHold;
		const row = { owned: this.scrollRangeOwners.has(range), held: !!hold, ready: hold?.ready, beforeTop: scroller.scrollTop, beforePan: { ...this.viewportPan }, afterTop: 0, afterPan: {}, consumed: false };
		row.consumed = consumer.call(this, range); row.afterTop = scroller.scrollTop; row.afterPan = { ...this.viewportPan }; boundaries.push(row); return row.consumed;
	};
	const warnings: string[] = [], warn = console.warn;
	console.warn = (...args: any[]) => { warnings.push(args.join(' ')); warn.apply(console, args); };
	const scrollWrites: unknown[] = [];
	const measures: unknown[] = [];
	const requestMeasure = view.requestMeasure.bind(view);
	const delayed = scenario === "delayed" || scenario === "takeover";
	let gateSettle = false;
	const heldMeasures: any[] = [];
	let settleReadSeen = false;
	let postMeasureGap: any = null, readWriteGap: any = null;
	if (input === 'nonconverging') {
		const updateExtent = overlay.updateExtent;
		overlay.updateExtent = function (...args: any[]) {
			const result = updateExtent.apply(this, args);
			if (this.panAnchorHold) rig.sizer.style.paddingTop = `${parseFloat(rig.sizer.style.paddingTop || '0') + 1}px`;
			return result;
		};
	}
	if (input === "postMeasure") view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of(() => {
		if (!settleReadSeen || postMeasureGap) return;
		const snapshot = () => ({ pan: { ...overlay.viewportPan }, left: scroller.scrollLeft, top: scroller.scrollTop });
		const top = scroller.scrollTop; scroller.scrollTop += 120;
		postMeasureGap = { delta: scroller.scrollTop - top, baseline: snapshot() };
		queueMicrotask(() => { postMeasureGap.after = snapshot(); });
	})) });
	// Delay the real CM frame, preserving its queued measurements and scroll
	// request together. Withholding only the custom request lets CM consume
	// the target before that work exists, which is not a slow frame.
	const requestFrame = window.requestAnimationFrame.bind(window);
	let schedulingMeasure = false;
	window.requestAnimationFrame = callback => {
		if (!schedulingMeasure) return requestFrame(callback);
		return requestFrame(time => {
			if (gateSettle && input !== 'postMeasure' && input !== 'missing' && input !== 'nonfirst') heldMeasures.push(() => callback(time));
			else callback(time);
		});
	};
	view.requestMeasure = (request: any) => {
		const previous = schedulingMeasure; schedulingMeasure = true;
		try {
			if (!request) return requestMeasure();
			const state = () => ({ generation: overlay.viewportGeneration, left: scroller.scrollLeft, top: scroller.scrollTop, k: overlay.pinchScaleNow });
			measures.push({ phase: 'request', ...state() });
			return requestMeasure({ ...request, read: (...args: any[]) => { const result = request.read(...args); if (gateSettle && request.key === overlay && input === 'postMeasure' && !settleReadSeen && result) { settleReadSeen = true; /* THE SETTLE MEASURE MAY BE EMPTY now that the release folds the scroll before the settle write (the fold absorbs the geometry change), and CodeMirror runs no update listener for an empty measure; an empty transaction after this read provokes the update the navigation rides on, between two compensation attempts as before. */ queueMicrotask(() => { if (!postMeasureGap) view.dispatch({}); }); } measures.push({ phase: 'read', result, ...state() }); return result; },
				write: (value: any, ...args: any[]) => {
					if (input === 'scrollReadWrite' && request.key === overlay && value && !readWriteGap) {
						const snapshot = () => ({ pan: { ...overlay.viewportPan }, left: scroller.scrollLeft, top: scroller.scrollTop });
						const top = scroller.scrollTop; scroller.scrollTop += 120;
						readWriteGap = { delta: scroller.scrollTop - top, baseline: snapshot() };
						request.write?.(value, ...args); readWriteGap.after = snapshot();
						// 6: A FRAME-SCALE WINDOW, NOT ONE MICROTASK. The compensation this cell is about used to
						// finish inside the settle's own turn, so a snapshot taken on the next line was the whole story.
						// With the canvas lift easing the page can still be moving when that line runs, and a cell
						// that reads one microtask after the write would be deciding on whichever half of the frame it
						// landed in. The later snapshot is taken a frame on, and the claim is read against it.
						const w = view.dom.ownerDocument.defaultView ?? window;
						w.requestAnimationFrame(() => w.requestAnimationFrame(() => { readWriteGap.afterFrame = snapshot(); }));
						return;
					}
					measures.push({ phase: 'write-before', value, ...state() }); request.write?.(value, ...args); measures.push({ phase: 'write-after', ...state() });
				} });
		} finally { schedulingMeasure = previous; }
	};
	// Named uncertainty: who changes the final scroll after lift? This trace
	// distinguishes the camera transaction from CodeMirror's later adjustment.
	for (const key of ['scrollLeft', 'scrollTop'] as const) {
		let proto: object | null = scroller, descriptor: PropertyDescriptor | undefined;
		while (proto && !descriptor) { descriptor = Object.getOwnPropertyDescriptor(proto, key); proto = Object.getPrototypeOf(proto); }
		if (!descriptor?.get || !descriptor.set) throw new Error('missing native scroll accessor');
		const native = descriptor;
		Object.defineProperty(scroller, key, { configurable: true,
			get() { return native.get!.call(this); },
			set(value: number) { native.set!.call(this, value); scrollWrites.push({ key, value, actual: native.get!.call(this), stack: new Error().stack }); },
		});
	}
	const router = overlay.router;
	const touch = (spread: number, f: { x: number; y: number }) => {
		router.touchPos.set(801, { x: f.x - spread / 2, y: f.y });
		router.touchPos.set(802, { x: f.x + spread / 2, y: f.y });
	};
	touch(400, focal);
	router.beginPinch(new PointerEvent('pointerdown', { pointerId: 802, pointerType: 'touch' }));
	// THE TAKEOVER'S FROZEN COLUMN, read on the first pinch frame that finds the
	// viewport owned (the takeover happens inside it), beside the rect read
	// above (columnAtStart). In this regime (ink far out, scrolled into it) the
	// unowned sizer's theme auto margin can read 0px while the sizer sits at its
	// centred offset; a takeover that froze that read made the first style
	// refresh re-commit and hop the column.
	const takeover = { ownedAtBegin: !!overlay.viewportLayout, owned: false, frozen: null as number | null };
	const samples: ReturnType<typeof sampleFocal>[] = [];
	const pinchCosts: { settle: boolean; rectReads: number }[] = [];
	const requests: { generation: number; left: number; top: number; wantedLeft: number; wantedTop: number; maxLeft: number; maxTop: number }[] = [];
	let activeFocal = focal;
	const originalRect = Element.prototype.getBoundingClientRect;
	let reads = 0;
	Element.prototype.getBoundingClientRect = function () { reads++; return originalRect.call(this); };
	const sampleFocal = (phase: string, f: { x: number; y: number }, cost: number) => {
		const r = originalRect.call(marker);
		const columnContentX = ((contentOriginLeft(view.contentDOM) ?? NaN) - originalRect.call(view.dom).left) / overlay.cssScale + scroller.scrollLeft;
		const targetX = Math.min(origin.x + f.x - focal.x, originalRect.call(view.dom).left + markerAtLeft * overlay.pinchScaleNow);
		const targetY = Math.min(origin.y + f.y - focal.y, originalRect.call(view.dom).top + markerAtTop * overlay.pinchScaleNow);
		return { phase, columnContentX, connected: marker.isConnected, k: overlay.pinchScaleNow, x: r.left, y: r.top, fx: origin.x + f.x - focal.x, fy: origin.y + f.y - focal.y,
			targetX, targetY, rawFocalDriftX: r.left - origin.x - f.x + focal.x, rawFocalDriftY: r.top - origin.y - f.y + focal.y,
			driftX: r.left - targetX, driftY: r.top - targetY,
			scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop,
			maxLeft: scroller.scrollWidth - scroller.clientWidth, maxTop: scroller.scrollHeight - scroller.clientHeight, rectReads: cost };
	};
	const apply = overlay.applyPinchScale;
	const writeScroll = overlay.setViewportScroll;
	overlay.setViewportScroll = function (left: number, top: number) {
		const r = originalRect.call(marker), scale = overlay.cssScale;
		requests.push({ generation: overlay.viewportGeneration, left, top, wantedLeft: scroller.scrollLeft + (r.left - origin.x - activeFocal.x + focal.x) / scale,
			wantedTop: scroller.scrollTop + (r.top - origin.y - activeFocal.y + focal.y) / scale,
			maxLeft: scroller.scrollWidth - scroller.clientWidth, maxTop: scroller.scrollHeight - scroller.clientHeight });
		return writeScroll.call(this, left, top);
	};
	overlay.applyPinchScale = function (next: number, commit: boolean, centroid: unknown) {
		const before = reads;
		const result = apply.call(this, next, commit, centroid);
		if (!takeover.owned && overlay.viewportLayout) { takeover.owned = true; takeover.frozen = overlay.viewportLayout.columnLocal; }
		pinchCosts.push({ settle: commit, rectReads: reads - before });
		samples.push(sampleFocal(commit ? 'commit-call' : 'preview-sync', activeFocal, reads - before));
		return result;
	};
	try {
		let f = focal;
		const ratios = delayed ? [1.25, 1.5, 2] : scenario === "maximum" || scenario === "lazy" ? [1.05, 1.05, 1.05] : [.5, .25, .25];
		for (const [i, k] of ratios.entries()) {
			f = { x: focal.x + (moving ? i * 23.25 : 0), y: focal.y + (moving ? i * 13.5 : 0) };
			if (scenario === "maximum" || scenario === "lazy") f = { x: focal.x - i * 200, y: focal.y - i * 140 };
			activeFocal = f;
			if (scenario === "lazy" && i === 1) {
				// Named uncertainty: incoming ink extends the surface while the
				// preview defers updateExtent. Does lift jump to a newly legal target?
				inlineInk.commit(path, { ...stroke, id: stroke.id + '-lazy', points: stroke.points.map(p => ({ ...p, x: p.x + 20000, y: p.y + 20000 })), bbox: { ...stroke.bbox, x: stroke.bbox.x + 20000, y: stroke.bbox.y + 20000 } });
			}
			touch(400 * k, f);
			reads = 0;
			router.updatePinch(new PointerEvent('pointermove', { pointerId: 802, pointerType: 'touch' }));
			await frame();
			const cost = reads;
			samples.push(sampleFocal('preview', f, cost));
		}
		reads = 0;
		gateSettle = delayed;
		router.endPinch(new PointerEvent('pointerup', { pointerId: 802, pointerType: 'touch' }), f);
		const settleGeneration = overlay.viewportGeneration, settleReceipt = overlay.panAnchorHold;
		 samples.push(sampleFocal('settle-sync', f, reads));
		// FORTY FRAMES, NOT EIGHT. Under the ruling the settle's correction is carried by an ease that runs for
		// OVERSCROLL_BOUNCE_MS, 500 ms, and eight frames land inside it - on a headless surface whose frames
		// run 19 to 23 ms they cover about a fifth of the glide, so a sample taken there reads a page that
		// is still moving and says nothing about where it came to rest. Forty frames outlast the glide.
		for (let i = 0; i < 40; i++) { reads = 0; await frame(); const cost = reads; samples.push(sampleFocal(`settle-${i}`, f, cost)); }
		let takeoverDelta = 0;
		let cancellation: any = null;
		if (delayed) {
			// Hold the actual camera measurement across unrelated frames and
			// beyond the old timeout. Time passing does not execute this work.
			if (scenario === "takeover") {
				const before = scroller.scrollTop;
				scroller.scrollTop += 120;
				takeoverDelta = scroller.scrollTop - before;
				origin.y -= takeoverDelta * overlay.cssScale;
				await frame(); samples.push(sampleFocal('navigation', f, 0));
			}
			const deadline = performance.now() + (input ? 0 : 450);
			while (performance.now() < deadline) { await frame(); samples.push(sampleFocal('delayed-wait', f, 0)); }
			if (input) {
				const heldBefore = !!overlay.panAnchorHold;
				const panBefore = { ...overlay.viewportPan };
				if (input === "postMeasure") { /* navigation ran in the public update listener */ }
				else if (input === "scrollImmediate" || input === "missing" || input === "nonfirst") scroller.scrollTop += 120;
				else if (input === "wheel") scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }));
				else if (input === "keyboard") view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
				else if (input === "pen") drawAt(view, pr.left + 400, pr.top + 200, 905);
				else if (input === "zoom") overlay.commitCameraScale(1, { left: 0, top: 0 });
				else if (input === "switch") { (view.state.field(editorInfoField) as any).file = { path: `${path}-next.md` }; view.dispatch({}); }
				else if (input === "destroy") { view.destroy(); destroyed = true; }
				else if (input && ['remove','recreate','reconfigureAll','mappedRemove','foreignReplace','setState'].includes(input.replace('Control',''))) {
					const mode = input.replace('Control','');
					if (mode === 'mappedRemove') view.dispatch({ changes: { from: 0, insert: 'mapped before removal\n' }, filter: false });
					if (mode === 'foreignReplace') view.dispatch({ effects: EditorView.scrollIntoView(EditorSelection.cursor(view.state.doc.length), { y: 'end' }), filter: false });
					if (mode === 'setState') view.setState(view.state);
					else if (mode === 'remove' || mode === 'recreate') {
						view.dispatch({ effects: rig.overlayCompartment.reconfigure([]), filter: false });
						if (mode === 'recreate') view.dispatch({ effects: rig.overlayCompartment.reconfigure(rig.overlayExtensions), filter: false });
					} else view.dispatch({ effects: StateEffect.reconfigure.of(rig.baseExtensions), filter: false });
				}
				else { touch(400, f); router.beginPinch(new PointerEvent('pointerdown', { pointerId: 802, pointerType: 'touch' })); touch(450, f); router.updatePinch(new PointerEvent('pointermove', { pointerId: 802, pointerType: 'touch' })); }
				const snapshot = () => ({ pan: { ...overlay.viewportPan }, left: scroller.scrollLeft, top: scroller.scrollTop, scale: overlay.pinchScaleNow, writes: requests.filter(r => r.generation === settleGeneration).length, container: !!overlay.container });
				const baseline = snapshot(), revoked = !overlay.panAnchorHold;
				gateSettle = false;
				for (const resume of heldMeasures) resume();
				await Promise.resolve();
				cancellation = { input, heldBefore, panBefore, revoked, revokedAfter: !overlay.panAnchorHold, baseline, after: snapshot() };
				if (input && ['remove','recreate','reconfigureAll','mappedRemove','foreignReplace','setState'].includes(input.replace('Control',''))) {
					await settle(8); cancellation.drained = snapshot();
					cancellation.consumerBeforeCleanup = view.state.facet(EditorView.scrollHandler).map(f => f.name);
					view.dispatch({ effects: StateEffect.reconfigure.of(rig.baseExtensions), filter: false });
					cancellation.consumerAfterCleanup = view.state.facet(EditorView.scrollHandler).map(f => f.name);
					cancellation.extendersAfterCleanup = view.state.facet(EditorState.transactionExtender).length;
				}
			} else {
				gateSettle = false;
				for (const resume of heldMeasures) resume();
				for (let i = 0; i < 20; i++) { await frame(); samples.push(sampleFocal(`released-${i}`, f, 0)); }
			}
		}
		if (scenario === "second") {
			// A new gesture starts from the settled 25% view. Keep the same DOM
			// marker; repositioning it in layout pixels would conceal anchor loss.
			const r = originalRect.call(marker);
			origin = { x: r.left, y: r.top }; focal = { ...origin }; activeFocal = focal;
			markerAtLeft = (r.left - originalRect.call(view.dom).left + scroller.scrollLeft * overlay.cssScale) / overlay.pinchScaleNow;
			markerAtTop = (r.top - originalRect.call(view.dom).top + scroller.scrollTop * overlay.cssScale) / overlay.pinchScaleNow;
			touch(400, focal); router.beginPinch(new PointerEvent('pointerdown', { pointerId: 802, pointerType: 'touch' }));
			for (const ratio of [2.92, 1.64, .4]) {
				touch(400 * ratio, focal); reads = 0;
				router.updatePinch(new PointerEvent('pointermove', { pointerId: 802, pointerType: 'touch' }));
				await frame(); const cost = reads; samples.push(sampleFocal('second-preview', focal, cost));
			}
			router.endPinch(new PointerEvent('pointerup', { pointerId: 802, pointerType: 'touch' }), focal);
			samples.push(sampleFocal('second-settle-sync', focal, 0));
			for (let i = 0; i < 8; i++) { await frame(); samples.push(sampleFocal(`second-settle-${i}`, focal, 0)); }
		}
		return { readable, infiniteCanvas, moving, scenario, consumerFirst: overlay.firstSettleConsumer?.(), consumerNames: view.state.facet(EditorView.scrollHandler).map(f => f.name), warnings, boundaries, cancellation, postMeasureGap, readWriteGap, settleOutcome: settleReceipt?.outcome, settleAttempts: settleReceipt?.attempts, heldMeasures: heldMeasures.length, takeoverDelta, holdRemaining: !!overlay.panAnchorHold, columnAtStart, takeover, pinchCosts, requests, scrollWrites, measures, strokes: inlineInk.strokes(path).length, initial: origin, samples };
	} finally { console.warn = warn; window.requestAnimationFrame = requestFrame; Element.prototype.getBoundingClientRect = originalRect; if (!destroyed) view.destroy(); pane.remove(); }
}


/** Repeated centroid movement after activation at an unchanged rendered scale.
 * Existing negative-target and second-pinch cases do not reach the pan bound
 * repeatedly or try to recover from it. Measure actual content/text rectangles,
 * reverse from the fixed hit surface, then scroll and write on the recovered page.
 * The former downward24px allowance is replaced by the natural top boundary.
 */
async function runCentroidPan(readable: boolean, infiniteCanvas: boolean) {
	const { pane, view, overlay, path } = await mount(`centroid-${readable}-${infiniteCanvas}`, readable, infiniteCanvas);
	const router = overlay.router, pr = pane.getBoundingClientRect(), scroller = view.scrollDOM;
	const samples: any[] = [], releases: any[] = [], warnings: string[] = [];
	const warn = console.warn;
	console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); warn.apply(console, args); };
	const point = (y: number) => ({ x: pr.left + pr.width / 2, y: pr.top + y });
	const touch = (spread: number, y: number) => {
		const f = point(y);
		router.touchPos.set(811, { x: f.x - spread / 2, y: f.y });
		router.touchPos.set(812, { x: f.x + spread / 2, y: f.y });
	};
	const event = (type: string) => new PointerEvent(type, { pointerId: 812, pointerType: 'touch' });
	// The fingers' own input, recorded beside every sample so a preview reads as commanded travel
	// rather than against a measured number.
	let lastY = 0;
	const move = (spread: number, y: number) => { lastY = y; touch(spread, y); return router.updatePinch(event('pointermove')); };
	const sample = (phase: string) => {
		const content = view.contentDOM.getBoundingClientRect(), line = view.contentDOM.querySelector('.cm-line');
		const range = document.createRange(); if (line) range.selectNodeContents(line);
		const text = line ? range.getBoundingClientRect() : null;
		const overlap = (top: number, bottom: number) => Math.max(0, Math.min(pr.bottom, bottom) - Math.max(pr.top, top));
		const hit = document.elementFromPoint(point(400).x, point(400).y);
		const row = { phase, scale: overlay.pinchScaleNow, panY: overlay.viewportPan.y, scrollTop: scroller.scrollTop,
			contentTop: content.top, contentBottom: content.bottom, overlapY: overlap(content.top, content.bottom),
			firstText: line?.textContent, textTop: text?.top, textOverlapY: text ? overlap(text.top, text.bottom) : 0,
			hitSurface: !!hit && scroller.contains(hit), scrollerTop: scroller.getBoundingClientRect().top };
		(row as any).centroidY = lastY;
		samples.push(row); return row;
	};
	const end = async (phase: string, y: number) => {
		const before = sample(`${phase}-before-lift`);
		router.endPinch(event('pointerup'), point(y));
		const hold = overlay.panAnchorHold;
		const immediate = sample(`${phase}-lift`);
		router.touchPos.clear(); await settle(8);
		// THIS RUNNER HAD NO ARRIVED WAIT AT ALL. `-settled` is 8 frames after the lift,
		// about 130 ms into a 500 ms glide, and `jump` was read from it - so the row that asks the ease
		// to close the whole 300.00 was reading it 44 per cent of the way down the cubic: measured
		// -246.35, and (1 - 0.44)^3 x 300 = 53 px left, which is exactly the shortfall. The sibling
		// runner's rows were fixed at the ruling; this one was missed because its `end()` is its own.
		// Wait the glide out in real time, then sample the arrival.
		const bouncing = (): boolean => typeof (overlay as any).overscrollBounceReadout === "function"
			&& (overlay as any).overscrollBounceReadout().active;
		const waitStart = performance.now();
		for (let w = 0; w < 40 && !bouncing(); w++) await frame();
		let seen = bouncing(), steady = 0, prev: number | null = null;
		while (performance.now() - waitStart < 1500 && !(seen && steady >= 2)) {
			await frame();
			if (bouncing()) seen = true;
			if (!seen && performance.now() - waitStart > 250) seen = true;
			const now = view.contentDOM.getBoundingClientRect().top;
			steady = !bouncing() && prev !== null && Math.abs(now - prev) <= 0.1 ? steady + 1 : 0;
			prev = now;
		}
		const after = sample(`${phase}-settled`);
		releases.push({ phase, outcome: hold?.outcome, held: !!overlay.panAnchorHold,
			syncJump: immediate.contentTop - before.contentTop, jump: after.contentTop - before.contentTop });
	};
	const begin = async (phase: string, y: number) => {
		// WAIT FOR THE EASE BEFORE THE NEXT GESTURE. Fingers landing mid-glide now stop the
		// page where it is, which is the contract - but it means a gesture started while the
		// previous release was still gliding leaves that release short of its own rest, and the release
		// rows read an uninterrupted ease: measured, the seed release arrived at -237.12 against the
		// -300.00 it owed, with the cancel traced to this very call, 83.6 px of ease still to run. The
		// mid-bounce grab has its own row (the saturation row, relative to each gesture's start); these
		// rows keep their uninterrupted-ease meaning, so the glide is allowed to finish first.
		for (let i = 0; i < 90 && typeof (overlay as any).overscrollBounceReadout === "function"
			&& (overlay as any).overscrollBounceReadout().active; i++) await frame();
		lastY = y;
		touch(400, y); router.beginPinch(event('pointerdown'));
		// A real spread change activates the production router. Return to its
		// original spread before the RAF; all measured translation frames retain
		// the original rendered zoom. Pure unchanged spread is checked separately.
		move(416, y); move(400, y); await frame(); sample(`${phase}-start`);
	};
	try {
		drawAt(view, (contentOriginLeft(view.contentDOM) ?? pr.left) + 80, pr.top + 200, 191);
		await settle(8);
		const original = JSON.stringify(inlineInk.strokes(path));
		touch(400, 400); router.beginPinch(event('pointerdown')); move(100, 400); await frame();
		await end('seed', 400);
		// THE WINDOW OPENS AFTER THE SEED'S EASE, not during it. Measured: at
		// `unengaged-before` the bounce readout was still active with fromX 524.06 / fromY 300 and y
		// 29.05 still to run, pan 0 and scrollLeft 0 on both samples - so `unengagedDelta` was reading
		// the tail of the previous gesture's glide, not a page the unengaged gesture had moved, and it
		// varied run to run (-6.89, -8.93, -11.14). The claim is about a gesture that never engages, so
		// the page has to be still before it starts.
		for (let i = 0; i < 90 && typeof (overlay as any).overscrollBounceReadout === "function"
			&& (overlay as any).overscrollBounceReadout().active; i++) await frame();
		const unengagedBefore = sample('unengaged-before');
		touch(400, 200); router.beginPinch(event('pointerdown'));
		const unengagedClaimed = move(400, 650); await frame();
		router.endPinch(event('pointerup'), point(650)); router.touchPos.clear();
		const unengagedAfter = sample('unengaged-after');
		for (let gesture = 0; gesture < 4; gesture++) {
			await begin(`down-${gesture}`, 200);
			for (const y of [350, 500, 650]) { move(400, y); await frame(); sample(`down-${gesture}-${y}`); }
			if (gesture === 3) {
				move(400, 575); await frame(); sample('saturated-reverse-75');
				// Continue past the overshoot without lifting either finger. This
				// distinguishes delayed reversal from a gesture that cannot recover.
				move(400, 200); await frame(); sample('saturated-return-start');
				move(400, 125); await frame(); sample('saturated-recovered');
			}
			await end(`down-${gesture}`, gesture === 3 ? 125 : 650);
		}
		await begin('reverse', 650);
		for (const y of [575, 500]) { move(400, y); await frame(); sample(`reverse-${y}`); }
		await end('reverse', 500);
		const beforeScroll = sample('scroll-before'), originalTop = scroller.scrollTop;
		scroller.scrollTop += 120; await settle(4); const afterScroll = sample('scroll-forward');
		scroller.scrollTop = originalTop; await settle(4); const afterReturn = sample('scroll-return');
		const beforeInk = inlineInk.strokes(path).length;
		const content = view.contentDOM.getBoundingClientRect(), penX = (contentOriginLeft(view.contentDOM) ?? content.left) + 20, penY = Math.max(pr.top + 100, content.top + 100);
		const penTarget = document.elementFromPoint(penX, penY), penHit = !!penTarget && scroller.contains(penTarget);
		drawAt(view, penX, penY, 919); await settle(8);
		return { readable, infiniteCanvas, samples, releases, warnings, unengagedClaimed,
			unengagedDelta: unengagedAfter.contentTop - unengagedBefore.contentTop,
			scrollDelta: afterScroll.scrollTop - beforeScroll.scrollTop, scrollPaintDelta: afterScroll.contentTop - beforeScroll.contentTop,
			scrollReturnDelta: afterReturn.contentTop - beforeScroll.contentTop, penHit,
			penStrokes: inlineInk.strokes(path).length - beforeInk,
			originalUnchanged: JSON.stringify(inlineInk.strokes(path).slice(0, beforeInk)) === original };
	} finally { console.warn = warn; view.destroy(); pane.remove(); }
}

/** Top exposure is measured against the note's actual zero-scroll layout,
 * including a title and padding. A strict top bound must not erase that inset.
 */
async function runTopBoundary(readable: boolean, infiniteCanvas: boolean, tiny = false, external = 1, axis: 'top' | 'left' | 'corner' = 'top', debug = false) {
	const { pane, view, overlay, sizer, path } = await mount(`${axis}-${readable}-${infiniteCanvas}-${tiny}`, readable, infiniteCanvas);
	const title = document.createElement('div'); title.textContent = 'A note title'; title.style.cssText = 'height:52px;flex:none';
	sizer.style.paddingTop = '16px'; sizer.insertBefore(title, sizer.firstChild);
	pane.style.transform = `scale(${external})`; pane.style.transformOrigin = '0 0'; overlay.handleResize();
	if (tiny) {
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'small' } });
		if (axis !== 'top') {
			// A narrow note with a real left inset exercises conflicting minimum
			// overlap on X too. Full notes retain the ordinary readable-line margin.
			sizer.style.width = '16px'; sizer.style.maxWidth = '16px'; sizer.style.marginLeft = '12px';
			view.contentDOM.style.width = '16px'; view.contentDOM.style.maxWidth = '16px';
		}
	}
	await settle(8);
	const pr = pane.getBoundingClientRect(), naturalInset = view.contentDOM.getBoundingClientRect().top - view.dom.getBoundingClientRect().top;
	const naturalLeft = contentOriginLeft(view.contentDOM)! - view.dom.getBoundingClientRect().left;
	if (!tiny && axis !== 'top') {
		// Actual synthetic ink grants native horizontal range in both IC modes.
		drawAt(view, contentOriginLeft(view.contentDOM)! + 80 * external, 200 * external, 193);
		await settle(8);
		const stroke = inlineInk.strokes(path)[0]!;
		inlineInk.commit(path, { ...stroke, id: stroke.id + '-far', points: stroke.points.map(p => ({ ...p, x: p.x + 10000, y: p.y + 10000 })), bbox: { ...stroke.bbox, x: stroke.bbox.x + 10000, y: stroke.bbox.y + 10000 } });
		overlay.scheduleRepaint('boundary-ink'); await settle(10);
	}
	const inkBefore = JSON.stringify(inlineInk.strokes(path));
	// THE INSTRUMENTED READ, test-time only and off by default. The settle-side push already lives on
	// the product path at this head and comes out before landing; this arms it for the two named
	// cells and nothing else, so one run can say which of the three named causes is the real one.
	if (debug) { (globalThis as any).__HW_PAN_DEBUG = true; (globalThis as any).__HW_SETTLE_PAN = []; }
	const router = overlay.router, rows: any[] = [], releases: any[] = [];
	// THE RULE WANTS THE FINGERS' DISPLACEMENT, NOT A MEASURED NUMBER. The rig already owns the only
	// inputs that displacement is made of - the centroid it placed the touches at and the spread between
	// them - so it records them beside every sample and the cell derives the expected exposure from them.
	// Nothing here reads a position back out of the product.
	let lastSpread = 0, lastPos = 0;
	const centroid = (position: number) => ({ x: pr.left + (axis === 'top' ? 500 : position), y: axis === 'left' ? 400 : position });
	const touch = (spread: number, position: number) => { lastSpread = spread; lastPos = position; const p = centroid(position); router.touchPos.set(831, { x: p.x - spread / 2, y: p.y }); router.touchPos.set(832, { x: p.x + spread / 2, y: p.y }); };
	const event = (type: string) => new PointerEvent(type, { pointerId: 832, pointerType: 'touch' });
	const move = (spread: number, y: number) => { touch(spread, y); router.updatePinch(event('pointermove')); };
	const sample = (phase: string) => {
		const top = view.contentDOM.getBoundingClientRect().top, expectedTop = view.dom.getBoundingClientRect().top + naturalInset * overlay.pinchScaleNow;
		const left = contentOriginLeft(view.contentDOM)!, expectedLeft = view.dom.getBoundingClientRect().left + naturalLeft * overlay.pinchScaleNow;
		const row = { phase, spread: lastSpread, centroidX: axis === 'top' ? 500 : lastPos, centroidY: axis === 'left' ? 400 : lastPos, left, expectedLeft, exposureX: left - expectedLeft, top, expectedTop, exposure: top - expectedTop, scale: overlay.pinchScaleNow, g: (() => { const L: any = (overlay as any).viewportLayout; const pp = (overlay as any).filePath?.(); return L ? { columnBox: L.columnBox, paneWidth: L.paneWidth, externalScale: L.externalScale, gutterX: L.gutterX, gutterScreen: L.gutterScreen, layoutWidth: L.width, columnInset: L.columnInset, inkOnlyX: pp ? inkFrontier(inlineInk.strokes(pp)).x : 0, conflatedX: pp ? (surfaceExtents.get(pp)?.x ?? 0) : 0, columnLocal: L.columnLocal, marginVar: parseFloat(view.dom.style.getPropertyValue('--handwriting-column-margin-left')) || 0, fontZoom: (overlay as any).fontZoom } : null; })(), scrollLeft: view.scrollDOM.scrollLeft, scrollTop: view.scrollDOM.scrollTop, panX: overlay.viewportPan.x, panY: overlay.viewportPan.y };
		// THE TERMS THE RULING NAMES, read at the sample rather than reconstructed: the overlay's CACHED ink
		// term beside the frontier the store actually holds, so a stale cache shows up as a disagreement
		// between two numbers in the same row rather than as an inference.
		if (debug) {
			const o = overlay as any, layout = o.viewportLayout;
			Object.assign(row, {
				pageInkX: o.pageInkX, columnBox: layout?.columnBox ?? null, fontZoom: o.fontZoom,
				pageContentWidth: Math.max(layout?.columnBox ?? 0, (o.pageInkX ?? 0) * o.fontZoom),
				storeFrontierX: surfaceExtents.get(path)?.x ?? null,
				strokeFrontierX: inkFrontier(inlineInk.strokes(path))?.x ?? null,
				fitReadout: o.panFitReadout ? o.panFitReadout() : null,
				// Why this frame was or was not bounded, straight from the gate.
				dragGate: (o as any).dragGateReadout ? (o as any).dragGateReadout() : null,
			});
		}
		rows.push(row); return row;
	};
	const begin = async (y = 200) => { touch(400, y); router.beginPinch(event('pointerdown')); move(384, y); move(400, y); await frame(); };
	const end = async (phase: string, y: number) => {
		const before = sample(`${phase}-before-lift`); router.endPinch(event('pointerup'), centroid(y));
		const immediate = sample(`${phase}-lift`), hold = overlay.panAnchorHold;
		router.touchPos.clear(); await settle(8); const after = sample(`${phase}-settled`);
		// ARRIVED. The `-settled` sample above is read 8 frames after the lift - about 133 ms
		// into an ease that runs for ~500 ms - so it is a GLIDE READ, not a position: three identical
		// repeats measured 787.38 / 869.06 / 838.65 there, while the rest itself is 689.5027 on every one.
		// A cell that never observes the ARRIVED state cannot guard the design's own promise that a drag
		// on a fitting page returns to its rest. Wait for the ease to END: two consecutive frames agreeing
		// within 0.1 px, bounded to 60 frames so a stuck glide FAILS the cell instead of hanging the suite.
		// BOTH AXES, and the overlay's own bounce state. This loop watched
		// contentOriginLeft alone, which is X: on the top-margin arms the ease runs on Y, so the
		// wait ended while it was still running and `-arrived` was a mid-glide sample - measured
		// 47.26 of 450 at repeat-0-arrived with the ease itself correct (painted 484, landed 34,
		// difference 450, the number the cell asks for). Same instrument defect as the ruling.
		// THE EASE CAN START AFTER THE FIRST FRAMES. The settle that owes it runs on a
		// later pass, so a wait that only asks "is it running now" can pass two steady frames before it
		// begins and sample a position the glide then leaves: measured, the seed release read -239.26
		// against -300.00 while the bounce was still to start, and the same glide was still running when
		// the next window opened. So first give it up to 12 frames to appear, then wait it out.
		const bouncing = (): boolean => typeof (overlay as any).overscrollBounceReadout === "function"
			&& (overlay as any).overscrollBounceReadout().active;
		// The ease may start several frames after the lift, and two identical frames before
		// it starts are not an arrival. The loop below will not accept steadiness until it has SEEN the
		// ease running, so a release whose glide begins late is still read at its rest (measured: the
		// seed release read -237.76 against the -300.00 it owed while the wait returned early).
		let seen = false;
		for (let w = 0; w < 40 && !bouncing(); w++) await frame();
		if (bouncing()) seen = true;
		// THE BOUND IS WALL CLOCK, NOT FRAMES. Headless rAF runs far faster than 16 ms, so a
		// 90-frame cap expired inside the 500 ms glide and the arrived sample was still mid-ease:
		// measured, the seed release read -227.95 / -247.26 against the -300.00 it owed while the ease's
		// own input was the full 300.00 (capture blank 300.00 with pan 300.00, landed 0.00), which is
		// about half way down the cubic. The loop now waits the glide out in real time.
		const easeStart = performance.now();
		let easePrevX: number | null = null, easePrevY: number | null = null, easeSteady = 0, easeFrames = 0;
		for (; performance.now() - easeStart < 1500 && !(seen && easeSteady >= 2); easeFrames++) {
			await frame();
			const nowX = contentOriginLeft(view.contentDOM);
			const nowY = view.contentDOM.getBoundingClientRect().top;
			if (bouncing()) seen = true;
			const still = !bouncing() && nowX !== null && easePrevX !== null && easePrevY !== null
				&& Math.abs(nowX - easePrevX) <= 0.1 && Math.abs(nowY - easePrevY) <= 0.1;
			easeSteady = still ? easeSteady + 1 : 0;
			if (!seen && performance.now() - easeStart > 250) seen = true;
			easePrevX = nowX; easePrevY = nowY;
		}
		const arrived: any = sample(`${phase}-arrived`);
		// recorded so an assertion can say "the ease never ended" instead of pinning a moving value
		arrived.eased = easeSteady >= 2; arrived.easeFrames = easeFrames;
		// `jump`/`jumpX` are read from the ARRIVED sample, not from `-settled`. The comment
		// above says what `-settled` is - 8 frames, about 133 ms into a 500 ms ease - so a cell asking
		// "the ease closes it after" against it was reading the glide: measured -120.20 / -270.44 /
		// -351.43 on three arms whose eases were correct. `syncJump` stays on the lift-instant sample,
		// which is the half of the claim that is about the lift.
		releases.push({ phase, syncJump: immediate.top - before.top, jump: arrived.top - before.top, syncJumpX: immediate.left - before.left, jumpX: arrived.left - before.left, settledJump: after.top - before.top, settledJumpX: after.left - before.left, outcome: hold?.outcome, held: !!overlay.panAnchorHold });
	};
	try {
		if (tiny) { if (!overlay.commitCameraScale(.1, { left: 0, top: 0 })) throw new Error('tiny-note zoom refused'); await settle(8); }
		sample('natural');
		touch(400, 400); router.beginPinch(event('pointerdown'));
		move(200, 400); await frame(); sample('zoom-out'); await end('zoom-out', 400);
		for (let i = 0; i < 3; i++) {
			await begin(); sample(`repeat-${i}-start`);
			for (const y of [350, 500, 650]) { move(400, y); await frame(); sample(`repeat-${i}-${y}`); }
			if (i === 2) { move(400, 575); await frame(); sample('reverse-75'); }
			await end(`repeat-${i}`, i === 2 ? 575 : 650);
		}
		if (!tiny) {
			overlay.commitCameraScale(.5, { left: axis === 'top' ? 0 : 500, top: axis === 'left' ? 0 : 500 }); await settle(8); sample('reachable-start');
			await begin(); const before = sample('reachable-before'); move(400, 240); await frame(); const after = sample('reachable-move');
			move(400, 650); await frame(); sample('reachable-top'); await end('reachable', 650);
			await begin(400);
			// GESTURE-START SAMPLES for the exposure law. The law reads a live sample as the exposure the
			// gesture STARTED with plus the centroid's travel since, so every arm whose live samples return to the
			// starting spread needs one row taken at that spread. `-begin` rather than `-start`: the `-start` suffix
			// is what the cells match to mean A RESTING POSITION, and these are taken with the fingers already down.
			sample('scale-only-begin');
			const frozen = JSON.stringify([overlay.pinchAnchor.focalX, overlay.pinchAnchor.focalY, overlay.pinchAnchor.hostTop, overlay.pinchAnchor.fromScale]);
			move(200, 400); await frame(); sample('scale-only-out'); move(400, 400); await frame(); sample('scale-only-back');
			const anchorUnchanged = frozen === JSON.stringify([overlay.pinchAnchor.focalX, overlay.pinchAnchor.focalY, overlay.pinchAnchor.hostTop, overlay.pinchAnchor.fromScale]);
			await end('scale-only', 400);
			overlay.commitCameraScale(.5, { left: 0, top: 0 }); await settle(8);
			await begin(400); sample('mixed-begin'); move(200, 450); move(400, 375); await frame(); sample('mixed-coalesced'); await end('mixed', 375);
			overlay.commitCameraScale(.5, { left: 0, top: 0 }); await settle(8);
			// The pending arm needs its own begin row for the ruling: its live exposure at the
			// lift is derived as begin + travel, because the arm deliberately coalesces its two moves with no
			// frame between them and therefore has no `-before-lift` sample to read. Adding a frame here would
			// destroy the very condition the arm exists to test.
			await begin(); sample('pending-begin'); move(400, 650); move(400, 575);
			router.endPinch(event('pointerup'), centroid(575)); router.touchPos.clear(); sample('pending-lift'); await settle(8); sample('pending-settled');
			// AN ARRIVED SAMPLE FOR THE PENDING ARM. `pending-settled` is read 8 frames after
			// the lift, which since 48c53add is mid-ease and not a position: it reads 149.996 / 129.842 on
			// the Infinite-Canvas-on arms where the arrival is 0. Every other arm already waits for the
			// ease to end before it claims a position; this one did not, so it takes the same wait.
			{
				let prev: number | null = null, steady = 0, frames = 0;
				for (; frames < 60 && steady < 2; frames++) {
					await frame();
					const now = contentOriginLeft(view.contentDOM);
					steady = now !== null && prev !== null && Math.abs(now - prev) <= 0.1 ? steady + 1 : 0;
					prev = now;
				}
				const arrived: any = sample('pending-arrived');
				arrived.eased = steady >= 2; arrived.easeFrames = frames;
			}
			return { axis, readable, infiniteCanvas, tiny, external, naturalInset, naturalLeft, rows, releases, contentBoxHost: parseFloat(getComputedStyle(view.scrollDOM).width), columnBox: sizer.offsetWidth, reachableDelta: after.top - before.top, reachableX: after.left - before.left, anchorUnchanged, inkUnchanged: JSON.stringify(inlineInk.strokes(path)) === inkBefore, settlePan: debug ? (globalThis as any).__HW_SETTLE_PAN : undefined };
		}
		return { axis, readable, infiniteCanvas, tiny, external, naturalInset, naturalLeft, rows, releases, contentBoxHost: parseFloat(getComputedStyle(view.scrollDOM).width), columnBox: sizer.offsetWidth, inkUnchanged: JSON.stringify(inlineInk.strokes(path)) === inkBefore, settlePan: debug ? (globalThis as any).__HW_SETTLE_PAN : undefined };
	} finally { view.destroy(); pane.remove(); }
}

/**
 * A COMMIT THAT CHANGES THE MARGIN LAW MUST PAY FOR IT IN THE SAME FRAME.
 *
 * `columnRestCentred` centres a page that fits the pane by writing the sizer's margin. When the page stops fitting -
 * which under Infinite Canvas happens the moment the granted extent grows past the pane - that margin is withdrawn and
 * the page jumps by the whole of it, because the term that would pay for the move, `columnRestPan`, returns null on the
 * same condition that withdrew the margin, and the settle only applies it behind the same fit test.
 *
 * Measured at e4642923 on `natural left/top bounds: left RLL=false IC=true tiny=true external=1`: the granted extent
 * goes 3072 -> 22528 across the lift, `width` 307.20 -> 2252.80 against a `span` of 1383.005364806867, the resolved
 * margin drops 5379.026824 -> 12, and the page moves 536.70 px with `viewportPan.x` 0 and `scrollLeft` 0 - no payment
 * of any kind. That is this rig's subject.
 *
 * The rig returns the LAW'S OWN TERMS beside each position, so the cell can pin the fitting page to the formula rather
 * than to the number this fixture happens to produce.
 */
async function runMarginPayment(readable: boolean, infiniteCanvas: boolean, external = 1) {
	const { pane, view, overlay, sizer, path } = await mount(`margin-payment-${readable}-${infiniteCanvas}`, readable, infiniteCanvas);
	const title = document.createElement('div'); title.textContent = 'A note title'; title.style.cssText = 'height:52px;flex:none';
	sizer.style.paddingTop = '16px'; sizer.insertBefore(title, sizer.firstChild);
	pane.style.transform = `scale(${external})`; pane.style.transformOrigin = '0 0'; overlay.handleResize();
	// The same narrow note the bounds cells use: a real left inset, so the margin the law writes is separable from the
	// note's own 12 px.
	view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'small' } });
	sizer.style.width = '16px'; sizer.style.maxWidth = '16px'; sizer.style.marginLeft = '12px';
	view.contentDOM.style.width = '16px'; view.contentDOM.style.maxWidth = '16px';
	await settle(8);
	const naturalLeft = contentOriginLeft(view.contentDOM)! - view.dom.getBoundingClientRect().left;
	const router = overlay.router, rows: any[] = [];
	/** The law's terms, recomputed here from the live inputs - deliberately the formula, never a literal. */
	const law = () => {
		const layout = overlay.viewportLayout;
		if (!layout) return { span: NaN, width: NaN, centred: NaN, columnBox: NaN, gutterX: NaN, grantX: NaN };
		const effective = layout.externalScale * overlay.pinchScaleNow;
		const grantX = surfaceExtents.get(path)?.x ?? 0;
		const width = Math.max(layout.columnBox, grantX * overlay.fontZoom) * effective;
		// SWITCHED WITH PRODUCTION. A law helper left on the superseded expression is a stale oracle
		// waiting for a caller to trip over it; its one assertion (ScrollColumnAnchorPinch:1307-1310)
		// compares the margin production WROTE against this, so both sides move together and cancel.
		const span = layout.width * layout.externalScale - layout.gutterScreen;
		return { span, width, centred: Math.max(0, (span - width) / 2) / effective, effective,
			columnBox: layout.columnBox, gutterX: layout.gutterX, grantX, paneWidth: layout.paneWidth, externalScale: layout.externalScale };
	};
	const sample = (phase: string) => {
		const left = contentOriginLeft(view.contentDOM)!, host = view.dom.getBoundingClientRect().left;
		// The RESOLVED margin, not the custom property: the property is written unclamped and the stylesheet clamps it
		// against the auto term, and it is the resolved one that carries the page (measured).
		const resolvedMargin = parseFloat(getComputedStyle(sizer).marginLeft);
		const row = { phase, offset: left - host, left, resolvedMargin, scale: overlay.pinchScaleNow,
			panX: overlay.viewportPan.x, scrollLeft: view.scrollDOM.scrollLeft,
			debt: (overlay as any).columnMarginDebt, restingMargin: (overlay as any).restingColumnMargin,
			pinchPreview: (overlay as any).pinchPreview, hold: !!(overlay as any).panAnchorHold, ...law() };
		rows.push(row); return row;
	};
	const centroid = (position: number) => ({ x: pane.getBoundingClientRect().left + position, y: 400 });
	const touch = (spread: number, position: number) => { const p = centroid(position); router.touchPos.set(931, { x: p.x - spread / 2, y: p.y }); router.touchPos.set(932, { x: p.x + spread / 2, y: p.y }); };
	const event = (type: string) => new PointerEvent(type, { pointerId: 932, pointerType: 'touch' });
	try {
		if (!overlay.commitCameraScale(.1, { left: 0, top: 0 })) throw new Error('tiny-note zoom refused');
		await settle(8);
		const fitting = sample('fitting');
		// NO GESTURE AT ALL: one more commit at the same scale. Nothing the user did asks the page to move, so if it
		// moves here the withdrawal is commit-driven rather than lift-driven, and a payment that rides the gesture's
		// pan anchor cannot reach it.
		overlay.commitCameraScale(.1, { left: 0, top: 0 }); await settle(8);
		const afterBareCommit = sample('after-bare-commit');
		touch(400, 400); router.beginPinch(event('pointerdown'));
		touch(200, 400); router.updatePinch(event('pointermove')); await frame();
		sample('preview');
		const before = sample('before-lift');
		router.endPinch(event('pointerup'), centroid(400));
		const lift = sample('lift');
		router.touchPos.clear(); await settle(8);
		const settled = sample('settled');
		// A commit carrying a scroll target clears the viewport pan as gesture residue (commitCameraScale). If the
		// payment is parked there it survives only until the next one, which is how an earlier attempt at this became
		// intermittent - so the rig takes one and reports whether the page held.
		overlay.commitCameraScale(.1, { left: 0, top: 0 }); await settle(8);
		const afterCommit = sample('after-commit-with-scroll');
		return { readable, infiniteCanvas, external, naturalLeft, rows,
			bareCommitMove: afterBareCommit.offset - fitting.offset,
			liftMove: lift.offset - before.offset, settleMove: settled.offset - before.offset,
			commitMove: afterCommit.offset - before.offset,
			marginChanged: Math.abs(lift.resolvedMargin - before.resolvedMargin) };
	} finally { view.destroy(); pane.remove(); }
}

/** A hovering pen stays in screen coordinates as the note zooms underneath. */
async function runPinchReticle(target: number, moving: boolean, external = 1) {
	const { pane, view, overlay, path } = await mount(`reticle-${target}-${moving}`, true, true);
	pane.style.transform = `scale(${external})`; pane.style.transformOrigin = "0 0"; overlay.handleResize(); await settle(8);
	const pr = pane.getBoundingClientRect(), router = overlay.router;
	let x = pr.left + 700, y = 400;
	const hover = () => view.scrollDOM.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'pen', pointerId: 851, clientX: x, clientY: y, buttons: 0, pressure: 0 }));
	const rows: any[] = [];
	const sample = (phase: string) => {
		const cursor = overlay.penCursorEl as HTMLElement, r = cursor.getBoundingClientRect();
		rows.push({ phase, visible: reticleVisible(getComputedStyle(cursor)), errorX: (r.left + r.right) / 2 - x, errorY: (r.top + r.bottom) / 2 - y, width: r.width });
	};
	const touch = (ratio: number) => { router.touchPos.set(852, { x: pr.left + 400 - 150 * ratio, y: 300 }); router.touchPos.set(853, { x: pr.left + 400 + 150 * ratio, y: 300 }); };
	const event = (type: string) => new PointerEvent(type, { pointerId: 853, pointerType: 'touch' });
	try {
		hover(); sample('hover');
		touch(1); router.beginPinch(event('pointerdown'));
		for (let i = 1; i <= 8; i++) {
			touch(1 + (target - 1) * i / 8); router.updatePinch(event('pointermove')); await frame(); sample(`preview-${i}`);
			if (moving) { x += 3; y += 2; hover(); sample(`hover-${i}`); }
		}
		router.endPinch(event('pointerup'), { x: pr.left + 400, y: 300 }); router.touchPos.clear(); sample('lift');
		await settle(8); sample('settled'); x += 20; y += 10; hover(); sample('moved');
		view.scrollDOM.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'pen', pointerId: 851 })); sample('leave');
		const result = { target, moving, external, rows, strokes: inlineInk.strokes(path).length, cursorRemoved: false };
		const cursor = overlay.penCursorEl as HTMLElement; view.destroy(); result.cursorRemoved = !cursor.isConnected; pane.remove(); return result;
	} catch (error) { view.destroy(); pane.remove(); throw error; }
}

/** Right/down traversal starts with the setting enabled and no distant ink. */
async function runInfiniteTraversal(readable: boolean, infiniteCanvas: boolean, zoom: number, mode: 'native' | 'pinch', seeded = false, cadence: 'frame' | 'pending' | 'zero' = 'frame') {
	const { pane, view, overlay, path } = await mount(`traversal-${readable}-${infiniteCanvas}-${zoom}-${mode}`, readable, infiniteCanvas);
	const scroller = view.scrollDOM, pr = pane.getBoundingClientRect(), router = overlay.router;
	if (seeded) { drawAt(view, contentOriginLeft(view.contentDOM)! + 80, 200, 861); await settle(8); }
	const inkBefore = JSON.stringify(inlineInk.strokes(path));
	let resizeCalls = 0;
	const resize = overlay.handleResize;
	overlay.handleResize = function (...args: any[]) { resizeCalls++; return resize.apply(this, args); };
	const rows: any[] = [];
	const sample = (phase: string) => {
		const r = view.contentDOM.getBoundingClientRect();
		const sc = scroller.getBoundingClientRect();
		const row: { jumpX?: number; jumpY?: number; travel?: number } & Record<string, any> = { phase, x: contentOriginLeft(view.contentDOM)!, y: r.top, left: scroller.scrollLeft, top: scroller.scrollTop,
			// The column's centre against the scroller's content box (the pane less its scrollbar gutter), screen px.
			restMissX: (r.left + r.right) / 2 - (sc.left + sc.right - (sc.width - scroller.clientWidth * sc.width / scroller.offsetWidth)) / 2,
			width: scroller.scrollWidth, height: scroller.scrollHeight, clientWidth: scroller.clientWidth, clientHeight: scroller.clientHeight,
			grant: { ...surfaceExtents.get(path) }, pan: { ...overlay.viewportPan }, resizeCalls, overflowX: getComputedStyle(scroller).overflowX };
		rows.push(row); return row;
	};
	const touch = (spread: number, dx: number, dy: number) => {
		router.touchPos.set(841, { x: pr.left + 800 + dx - spread / 2, y: 600 + dy });
		router.touchPos.set(842, { x: pr.left + 800 + dx + spread / 2, y: 600 + dy });
	};
	const event = (type: string) => new PointerEvent(type, { pointerId: 842, pointerType: 'touch' });
	try {
		sample('startup');
		overlay.commitCameraScale(zoom, { left: 0, top: 0 }); await settle(10);
		await new Promise(resolve => setTimeout(resolve, 200));
		const initial = sample('zoomed');
		for (const axis of ['x', 'y'] as const) for (let i = 0; i < 4; i++) {
			const before = sample(`${axis}-${i}-before`);
			if (mode === 'native') {
				if (axis === 'x') scroller.scrollLeft = scroller.scrollWidth;
				else scroller.scrollTop = scroller.scrollHeight;
				if (seeded) {
					// Admit the real offset before a simultaneous host resize moves
					// the raster band. Its mechanical rebase must retain demand.
					scroller.dispatchEvent(new Event('scroll'));
					pane.style.height = `${PANE_H + (i % 2 ? 0 : 10)}px`;
				}
				await settle(8);
			} else {
				touch(400, 0, 0); router.beginPinch(event('pointerdown'));
				touch(416, 0, 0); router.updatePinch(event('pointermove'));
				touch(400, 0, 0); router.updatePinch(event('pointermove')); if (cadence !== 'zero') await frame();
				sample(`${axis}-${i}-activated`);
				for (const distance of [200, 400, 600, 800]) {
					touch(400, axis === 'x' ? -distance : 0, axis === 'y' ? -distance : 0);
					router.updatePinch(event('pointermove')); if (cadence === 'frame' || cadence === 'pending' && distance < 800) await frame();
					sample(`${axis}-${i}-${distance}`);
				}
				const last = sample(`${axis}-${i}-before-lift`);
				router.endPinch(event('pointerup'), { x: pr.left + 800 - (axis === 'x' ? 800 : 0), y: 600 - (axis === 'y' ? 800 : 0) });
				router.touchPos.clear();
				// THE LIFT'S OWN FRAME. This sample is the one the `expectedJump` rows below
				// are about - what the commit did, before any ease has run - and it was taken 10 frames
				// after the lift, which is inside the 500 ms glide: measured 79.71 and 551.82 where the
				// rows ask for 0. The settle still runs, and the rest is still read at `-done` below.
				const after = sample(`${axis}-${i}-after`);
				await settle(10);
				after.jumpX = after.x - last.x; after.jumpY = after.y - last.y;
				// Alan 2026-09-21: under the canvas the settle measures the painted travel, so the last move a pending
				// cadence never painted (200 px) is eased after the lift and no longer lands in the lift's own frame. Measured
				// at d624596d plus the travelled flag: jump 0 where this row read -200. The rest is still read at `-done`.
				const pendingJump = infiniteCanvas ? 0 : -200;
				after.expectedJumpX = axis === 'x' ? cadence === 'zero' ? -800 : cadence === 'pending' ? pendingJump : 0 : 0;
				after.expectedJumpY = axis === 'y' ? cadence === 'zero' ? -800 : cadence === 'pending' ? pendingJump : 0 : 0;
				await new Promise(resolve => setTimeout(resolve, 150));
				// A settle that corrects a fitting axis glides for half a second: read the row below at rest, not part-way.
				for (let f = 0; f < 90 && overlay.overscrollBounceReadout && overlay.overscrollBounceReadout().active; f++) await frame();
			}
			const after = sample(`${axis}-${i}-done`); after.travel = (before[axis] - after[axis]);
		}
		return { readable, infiniteCanvas, zoom, mode, seeded, cadence, initial, rows, strokes: inlineInk.strokes(path).length, inkUnchanged: JSON.stringify(inlineInk.strokes(path)) === inkBefore };
	} finally { view.destroy(); pane.remove(); }
}

/**
 * Room to write BELOW the text on a note nobody has inked, once the note
 * viewport is zoomed out. Alan, at 10% with Infinite Canvas off: the page
 * nearly fits the screen, a finger drag downward stops after about 180px and
 * a drag to the right keeps going, so it reads as a scroll that only works
 * sideways. `lines` is how tall the document is - the short arm is his note,
 * the long one is the document every other arm in this fixture uses.
 *
 * Nothing is drawn and no pen is seen, so the write frontier is due here only
 * because of the zoom. The native scroll at the end is the reachability half:
 * a granted extent nobody can scroll to is not room.
 */
async function runZoomedWriteRoom(readable: boolean, infiniteCanvas: boolean, zoom: number, lines: number) {
	const { pane, view, overlay, path } = await mount(`write-room-${readable}-${infiniteCanvas}-${zoom}-${lines}`, readable, infiniteCanvas, undefined, false, lines);
	const scroller = view.scrollDOM;
	const sample = (phase: string) => ({
		phase, top: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
		range: scroller.scrollHeight - scroller.clientHeight, grant: { ...surfaceExtents.get(path) },
	});
	try {
		const startup = sample('startup');
		overlay.commitCameraScale(zoom, { left: 0, top: 0 });
		await settle(10);
		await new Promise(resolve => setTimeout(resolve, 200));
		const zoomed = sample('zoomed');
		scroller.scrollTop = scroller.scrollHeight;
		scroller.dispatchEvent(new Event('scroll'));
		await settle(8);
		const scrolled = sample('scrolled');
		return { kind: 'zoomed-write-room', readable, infiniteCanvas, zoom, lines, startup, zoomed, scrolled,
			scale: overlay.pinchScaleNow, strokes: inlineInk.strokes(path).length,
			hostZoom: (overlay as any).hostZoomSupported() as boolean, engineZoom: CSS.supports("zoom", "0.5") };
	} finally { view.destroy(); pane.remove(); }
}

/** Real hit-tested contacts across the visible expanded viewport. */
async function runExpandedDrawCoverage(mode: 'zoom' | 'traverse' | 'resize' | 'scroll-zoom' | 'scroll-fast' | 'scroll-zero' | 'retained-pan' | 'retained-pan-immediate' | 'retained-pan-bottom' | 'far-mark' | 'far-mark-fling' | 'far-mark-immediate' | 'far-mark-immediate-font', readable = true, capture = false, hostShell = false) {
 const {pane,view,overlay,path}=await mount(`expanded-draw-${mode}-${readable}`,readable,true,undefined,hostShell);
 if(mode.startsWith('retained-pan')){
  const shell=(pane.closest('.workspace-leaf')??pane) as HTMLElement;
  shell.style.width='905px';shell.style.height='746.890625px';shell.style.marginLeft='244px';shell.style.top='78.109375px';
  view.dom.style.width='905px';view.dom.style.height='746.7109375px';await settle(8);
 }
 const scroller=view.scrollDOM, rows:any[]=[];
 const geometry=()=>({pane:pane.getBoundingClientRect().toJSON(),scroller:scroller.getBoundingClientRect().toJSON(),band:overlay.container.getBoundingClientRect().toJSON(),ink:overlay.inkLayer.getBoundingClientRect().toJSON(),canvas:overlay.committedCanvas.getBoundingClientRect().toJSON(),backing:{width:overlay.committedCanvas.width,height:overlay.committedCanvas.height},scale:overlay.cssScale,pan:{...overlay.viewportPan},scroll:{left:scroller.scrollLeft,top:scroller.scrollTop},grant:{...surfaceExtents.get(path)}});
 const pixelsAt=(x:number,y:number)=>[overlay.wetCanvas,overlay.tailCanvas,overlay.committedCanvas].map((canvas:HTMLCanvasElement)=>{
  const r=canvas.getBoundingClientRect(),inside=x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom;
  // A 0x0 canvas (the wet canvas released while the page scrolled) holds no pixels to read.
  if(!inside||!(canvas.width>0&&canvas.height>0))return {inside,pixels:0};
  const bx=canvas.width/r.width,by=canvas.height/r.height,left=Math.max(0,Math.floor((x-r.left-9)*bx)),top=Math.max(0,Math.floor((y-r.top-9)*by)),w=Math.min(canvas.width-left,Math.ceil(18*bx)),h=Math.min(canvas.height-top,Math.ceil(18*by));
  const data=canvas.getContext('2d')!.getImageData(left,top,w,h).data;let pixels=0;
  for(let i=0;i<data.length;i+=4)if(data[i+3]!>20&&data[i+2]!>180&&data[i]!<60&&data[i+1]!<60)pixels++;
  return {inside,pixels};
 });
 try{
  drawAt(view,contentOriginLeft(view.contentDOM)!+80,200,881);await settle(8);
  if(mode.startsWith('scroll-')||mode.startsWith('retained-pan')){
   if(mode==='scroll-zero'){overlay.commitCameraScale(.4,{left:0,top:0});await settle(8);}
   await new Promise(r=>setTimeout(r,160));scroller.scrollLeft=scroller.scrollWidth;
   if(mode==='scroll-zoom'){scroller.dispatchEvent(new Event('scroll'));await settle(8);}
   const pr=pane.getBoundingClientRect(),router=overlay.router;
   const touch=(spread:number)=>{router.touchPos.set(871,{x:pr.left+800-spread/2,y:400});router.touchPos.set(872,{x:pr.left+800+spread/2,y:400});};
   const e=(type:string)=>new PointerEvent(type,{pointerId:872,pointerType:'touch'});
   touch(400);router.beginPinch(e('pointerdown'));
   if(mode!=='scroll-zero'){touch(240);router.updatePinch(e('pointermove'));await frame();}
   touch(mode==='scroll-zero'?100:40);router.updatePinch(e('pointermove'));
   router.endPinch(e('pointerup'),{x:pr.left+800,y:400});router.touchPos.clear();
   if(mode==='scroll-zoom')await settle(10);
  }else{overlay.commitCameraScale(.1,{left:0,top:0});await settle(10);}
  if(mode.startsWith('far-mark')){
   // ALAN'S SEQUENCE AND ALAN'S PANE (Orion, 2026-09-13, build 1765514b):
   // 10%, then scroll down AND right, marking every now and then. The window
   // was 1024x800 CSS at DPR 2, so the editor pane is about 973x704 once the
   // ribbon and the header are taken off. The far position is reached the way
   // the lag arm reaches it: room granted on both axes, then a plain scroll.
   const shell=(pane.closest('.workspace-leaf')??pane) as HTMLElement;
   shell.style.width='973px';shell.style.height='704px';view.dom.style.width='973px';view.dom.style.height='704px';await settle(8);
   // The font variant: the camera is stored in note units divided by the
   // font zoom, so a band carried by a layout-px delta is only exact when the
   // two units agree. 20px over the fixture's 16px is fontZoom 1.25.
   if(mode==='far-mark-immediate-font'){view.contentDOM.style.fontSize='20px';view.requestMeasure();await settle(8);}
   surfaceExtents.grow(path,{x:60000,y:60000});(overlay as any).updateExtent(true);await settle(10);
   scroller.scrollLeft=30000;scroller.scrollTop=30000;scroller.dispatchEvent(new Event('scroll',{bubbles:true}));await settle(10);
  }
  if(mode==='resize'){((pane.closest('.workspace-leaf')??pane) as HTMLElement).style.width='1900px';await settle(10);}
  if(mode==='traverse')for(let i=0;i<3;i++){await new Promise(r=>setTimeout(r,160));scroller.scrollLeft=scroller.scrollWidth;scroller.dispatchEvent(new Event('scroll'));await settle(8);}
  if(mode.startsWith('retained-pan')){
   // Replay the measured post-gesture geometry, independent of which host
   // scroll consumer left this residual pan. Pointer routing remains real.
   await settle(10);overlay.retirePanSettle();scroller.scrollLeft=0;scroller.scrollTop=0;
   overlay.viewportPan={x:-349.9767,y:mode==='retained-pan-bottom'?-350:-25.75};overlay.writeViewportPan();
   if(mode!=='retained-pan-immediate'){overlay.handleResize();overlay.repaint();await settle(8);}
  }
  pickStripColor('Probe','#0000ff');
  // THIS ARM MEASURES MAPPING, AND SHAPE SNAP WAS ANSWERING FOR IT.
  //
  // What the contacts below check is that a pen put down at a screen point is
  // stored at the note point the camera says it is - `mappingError`, asserted
  // per contact by ScrollColumnAnchorPinch.test.ts. Nothing here is about
  // shape recognition.
  //
  // MEASURED (L1e/DEFECT-B-READER.md): shape snap's dwell is WALL TIME since
  // the last raw move (DWELL_MS = 350, ShapeSnap.ts:21). Each contact sends 12
  // moves behind `await frame()` and then reads a `getImageData` plus seven
  // rects before the release, so under any build that makes forced layout
  // dearer that gap crosses 350 ms, the release reads as a deliberate hold
  // nobody performed, and the freehand is replaced by a fitted line: 1811, 152
  // and 152 points for 13 pointer events, `pressure` 0.5, `t` in steps of 8 -
  // ShapeSnap.ts:405's resampler. `mappingError` is then null because the
  // lengths no longer match, and the arm reports a mapping failure that never
  // happened. With `setShapeSnap(false)` and nothing else changed, the same
  // contacts store exactly 13 points and the mapping error is 1.5e-5, equal to
  // the build without the anchor to three digits.
  //
  // So the snap is off for the measurement and NOTHING the arm asserts about
  // mapping is relaxed. `setShapeSnap` is the seam the snap suites already use
  // (SnapChipOffer.test.ts, SnapPreviewIntegration.test.ts), not a new one.
  //
  // THE DWELL BEHAVIOUR ITSELF IS A SEPARATE FINDING, recorded and routed, not
  // fixed here: a hold nobody performed still snaps, the same shape as the
  // mouse defect SnapChip.ts was built for (Alan, hardware, 2026-09-05, "it's
  // correcting into a straight line").
  setShapeSnap(false);
  const initial=geometry(),pr=pane.getBoundingClientRect();
  const contacts=[{from:.35,to:.95},{from:.75,to:.8},{from:.9,to:.95}];
  for(let i=0;i<contacts.length;i++){
   const c=contacts[i]!,y=pr.top+(mode.startsWith('retained-pan')?pr.height*(.35+i*.275):250+i*90),x0=pr.left+pr.width*c.from,x1=pr.left+pr.width*c.to,id=882+i,t=performance.now(),hits:any[]=[],expected:{x:number;y:number}[]=[];
   const pen=(type:string,x:number,step:number)=>{const target=document.elementFromPoint(x,y);hits.push({type,x,now:performance.now(),target:target?.className,inScroller:!!target&&scroller.contains(target)});if(type!=='pointerup'){const scale=view.dom.getBoundingClientRect().width/parseFloat(getComputedStyle(view.dom).width),top=view.contentDOM.getBoundingClientRect().top+parseFloat(getComputedStyle(view.contentDOM).paddingTop)*scale;expected.push({x:(x-contentOriginLeft(view.contentDOM)!)/scale/(overlay.fontZoom||1),y:(y-top)/scale/(overlay.fontZoom||1)});}const e=new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:'pen',pointerId:id,isPrimary:true,clientX:x,clientY:y,pressure:.8,buttons:type==='pointerup'?0:1});Object.defineProperty(e,'timeStamp',{value:t+step*16});target?.dispatchEvent(e);};
   // far-mark: a scroll on both axes, then the mark ONE frame later - the
   // band reposition and its repaint are still in flight when the pen lands,
   // which is the overlap the complaint names. 240 visual px per scroll.
   // far-mark-immediate: the pen lands in the SAME task as the last scroll
   // write, before the frame that would have re-pinned the band. Zero scrolls
   // arrive during the contact; the band is simply stale for all of it.
   if(mode.startsWith('far-mark')){scroller.scrollLeft+=240/overlay.cssScale;scroller.scrollTop+=240/overlay.cssScale;scroller.dispatchEvent(new Event('scroll',{bubbles:true}));if(!mode.startsWith('far-mark-immediate'))await frame();}
   // Carry cost and per-move coverage (review of 03c445f0): the
   // carry is wrapped for this contact only and restored below; coverage is
   // read after every move, not once at the end.
   const carries:number[]=[],perMove:{move:number;right:boolean;bottom:boolean}[]=[];
   const carryOriginal=overlay.carryBandUnderLock;
   if(typeof carryOriginal==='function')overlay.carryBandUnderLock=function(this:any,...args:any[]){const t0=performance.now();const r=carryOriginal.apply(this,args);carries.push(performance.now()-t0);return r;};
   const before=inlineInk.strokes(path).length;
   pen('pointerdown',x0,0);
   for(let j=1;j<=12;j++){
    pen('pointermove',x0+(x1-x0)*j/12,j);
    if(mode.startsWith('far-mark')){const cr=overlay.committedCanvas.getBoundingClientRect();perMove.push({move:j,right:cr.right>=pr.right-1,bottom:cr.bottom>=pr.bottom-1});}
    // far-mark-fling: the fling is still running when the pen lands, so
    // scroll events keep arriving DURING the contact. syncBand refuses them
    // while the frame is locked and defers to pen-up; this is the arm that
    // says whether the deferred sync and its repaint actually land.
    if(mode==='far-mark-fling'){scroller.scrollLeft+=20/overlay.cssScale;scroller.scrollTop+=20/overlay.cssScale;scroller.dispatchEvent(new Event('scroll',{bubbles:true}));}
    await frame();
   }
   const wet=pixelsAt(x1,y),during=geometry();
   // 2: THE INK IS GLUED TO THE PAGE, SO THE READ FOLLOWS THE PAGE. A pen that lands inside
   // half a second of a lift cancels the settle's ease; the ruling folds the remainder into the pan so the page
   // stays under the pen while the stroke is drawn, and at the lift `resumeStrandedPan` finishes the glide the
   // pen cut. The stroke rides the page, as ink must, so a
   // fixed screen point reads empty afterwards through no fault of the ink. Measured on this rig with the canvas
   // ease on: under the pen at the lift 38 committed pixels on both cancelling arms, mappingError 0, and the
   // ink's scanned box matching the pen's x to 0.1 px while its y sat exactly the ease's remainder away
   // (160.00 on scroll-fast, 20.50 on scroll-zoom).
   // So the page's own travel between the lift and the settle is measured off the PAGE - the content box's
   // rect - and the settled read is taken at the pen point moved by it. Where nothing eases the travel is 0 and
   // this is the old read, unchanged.
   const pageRect=()=>{const r=view.contentDOM.getBoundingClientRect();return {x:r.left,y:r.top};};
   const pageAtLift=pageRect();
   pen('pointerup',x1,13);
   const committedAtLift=pixelsAt(x1,y);
   await settle(8);
   const pageAtSettle=pageRect();
   const pageTravel={x:pageAtSettle.x-pageAtLift.x,y:pageAtSettle.y-pageAtLift.y};
   const committedAfterTravel=pixelsAt(x1+pageTravel.x,y+pageTravel.y);
   if(typeof carryOriginal==='function')overlay.carryBandUnderLock=carryOriginal;
   // L1e defect B: 1811 points came out of 13 pointer events with the anchor
   // present and exactly 13 without it, so the question is not "was the stroke
   // lost" but "what scale and origin was it built against". Everything the
   // stroke path could have read is captured here, in one synchronous block,
   // so the two arms can be diffed field by field rather than argued about.
   const heldNow=documentAnchorLadder(view as never);
   const cnt=view.contentDOM.getBoundingClientRect(),cc=view.contentDOM.parentElement?.getBoundingClientRect(),
    szr=view.contentDOM.parentElement?.parentElement?.getBoundingClientRect();
   const strokeProbe={
    anchor:{present:!!heldNow,rungs:heldNow?.rungs.length??0,reach:(heldNow?.rungs.length??0)>0?((heldNow!.rungs.length-1)*heldNow!.spacing):0},
    cam:{...overlay.camera.snapshot},
    cssScale:overlay.cssScale,fontZoom:overlay.fontZoom,scale:overlay.scale,
    rasterPan:overlay.rasterPan?{...overlay.rasterPan}:null,viewportPan:{...overlay.viewportPan},
    band:overlay.band?{...overlay.band}:null,
    spacer:{left:overlay.spacerLeft,top:overlay.spacerTop},
    lastSync:{rectTop:overlay.lastSyncRectTop,rectLeft:overlay.lastSyncRectLeft,docTop:overlay.lastSyncDocumentTop,contentLeft:overlay.lastSyncContentLeft,scrollTop:overlay.lastSyncScrollTop,scrollLeft:overlay.lastSyncScrollLeft},
    geom:{scrollHeight:scroller.scrollHeight,scrollWidth:scroller.scrollWidth,
     contentTop:cnt.top,contentLeft:cnt.left,contentHeight:cnt.height,
     containerTop:cc?.top??null,containerHeight:cc?.height??null,
     sizerTop:szr?.top??null,sizerHeight:szr?.height??null,
     bandRectTop:overlay.container.getBoundingClientRect().top,bandRectLeft:overlay.container.getBoundingClientRect().left,
     columnLeft:contentOriginLeft(view.contentDOM)},
    frameLocked:overlay.frame?.locked??null,panAnchorHeld:!!overlay.panAnchorHold,pinchPreview:!!overlay.pinchPreview,
   };
   const added=inlineInk.strokes(path).slice(before),saved=sidecars.get(ids.get(path)!);
   const mapped=added[0]?.points??[],mappingError=mapped.length===expected.length?Math.max(...mapped.map((p,j)=>Math.hypot(p.x-expected[j]!.x,p.y-expected[j]!.y)*overlay.cssScale)):null;
   const lastMove=[...hits].reverse().find((h:any)=>h.type==='pointermove'),up=hits.find((h:any)=>h.type==='pointerup');
   // ATTRIBUTION, not inference: the actual wall-clock gap between the last raw
   // move and the release, which is the quantity shape snap's DWELL_MS = 350
   // is compared against.
   const dwellGapMs=lastMove&&up?(up as any).now-(lastMove as any).now:null;
   rows.push({committedAtLift,committedAfterTravel,pageTravel,from:c.from,to:c.to,x0,x1,y,hits,dwellGapMs,strokeProbe,carries,perMove,fontZoom:overlay.fontZoom,firstPoints:(added[0]?.points??[]).slice(0,3),lastPoints:(added[0]?.points??[]).slice(-3),strokesAdded:added.length,expectedLen:expected.length,mappedLen:mapped.length,downInScroller:hits[0]?.inScroller,movesInScroller:hits.filter((h:any)=>h.type==='pointermove'&&h.inScroller).length,targets:Array.from(new Set(hits.map((h:any)=>h.target))),wet,committed:pixelsAt(x1,y),mappingError,during,after:geometry(),added:added.map(s=>({id:s.id,points:s.points,bbox:s.bbox})),savedPoints:saved?parsePage(saved,ids.get(path)!).data.strokes.slice(before).map(s=>s.points):[]});
  }
  // L1e instrumentation: what the anchor actually was during this arm, so an
  // arm cannot be mistaken for the arm it was meant to be. The first two
  // attempts at this bisect were both invalidated by exactly that - one by a
  // shared page, one by an ablation that silently left the anchor unmounted.
  const held=documentAnchorLadder(view as never);
  const container=view.contentDOM.parentElement as HTMLElement|null;
  const sizerEl=container?.parentElement as HTMLElement|null;
  const anchorGeometry={
   wrapperPresent:!!held, rungs:held?.rungs.length??0, spacing:held?.spacing??0,
   reachLayoutPx:(held?.rungs.length??0)>0?((held!.rungs.length-1)*held!.spacing):0,
   wrapperPosition:held?getComputedStyle(held.wrapper).position:null,
   wrapperNextIsContent:held?held.wrapper.nextSibling===view.contentDOM:null,
   scrollHeight:scroller.scrollHeight, scrollWidth:scroller.scrollWidth,
   sizerHeight:sizerEl?sizerEl.getBoundingClientRect().height:null,
   containerClass:container?.className??null,
   containerDisplay:container?getComputedStyle(container).display:null,
   containerFlexDirection:container?getComputedStyle(container).flexDirection:null,
   containerAlignItems:container?getComputedStyle(container).alignItems:null,
   spacerTop:overlay.spacerTop, grant:{...surfaceExtents.get(path)},
  };
  // Restored so one arm cannot leak into the next, and so every other fixture
  // in this file keeps the shipped default.
  setShapeSnap(true);
  return {mode,readable,initial,rows,anchorGeometry};
 }finally{if(!capture){view.destroy();pane.closest('.workspace-leaf')?.remove();pane.remove();}}
}

/** Ordered clipping before one paint, including scale-only rejected movement. */
async function runConstraintOrder(mode: 'coalesced' | 'pending' | 'scale' | 'mixed' | 'corner', infiniteCanvas = false) {
	// THE ARM STATES ITS OWN MODE. It passed `true` for `mount`'s `infiniteCanvas` argument and
	// never said so - every arm ran canvas-ON while the cell titles claimed nothing either way. That was close
	// to harmless while the two modes differed little on this path; with the band it decides whether the drag
	// is bounded at all. Measured when the flag was first threaded: coalesced capped at the 96 px give on a
	// cell asking for canvas OFF, because `mount`'s own argument won. The mode goes THROUGH mount, which is
	// what sets the global for the overlay this arm builds.
	const { pane, view, overlay } = await mount(`constraint-${mode}`, true, infiniteCanvas);
	const naturalLeft = contentOriginLeft(view.contentDOM)! - view.dom.getBoundingClientRect().left;
	const router = overlay.router, pr = pane.getBoundingClientRect(), start = { x: pr.left + 400, y: pr.top + 200 };
	const rows: any[] = [];
	const touch = (spread: number, x: number, y: number) => {
		router.touchPos.set(821, { x: x - spread / 2, y }); router.touchPos.set(822, { x: x + spread / 2, y });
	};
	const event = (type: string) => new PointerEvent(type, { pointerId: 822, pointerType: 'touch' });
	const move = (spread: number, dx = 0, dy = 0) => { touch(spread, start.x + dx, start.y + dy); router.updatePinch(event('pointermove')); };
	const sample = (phase: string) => {
		const r = view.contentDOM.getBoundingClientRect();
		const row = { phase, x: contentOriginLeft(view.contentDOM), y: r.top, scale: overlay.pinchScaleNow,
			constraint: overlay.pinchAnchor?.constraint ? { ...overlay.pinchAnchor.constraint } : null,
			// The gate's own inputs on this frame, so a red on this arm says which clamp took it.
			panY: overlay.panY ? overlay.panY() : null, panX: overlay.panX ? overlay.panX() : null,
			gate: (overlay as any).dragGateReadout ? (overlay as any).dragGateReadout() : null };
		rows.push(row); return row;
	};
	// Magnification first travels into the legal top range, then back to the
	// boundary. Zooming out first would already be a constrained excursion.
	const begin = async () => {
		touch(400, start.x, start.y); router.beginPinch(event('pointerdown'));
		move(416); move(400); await frame();
	};
	const end = async (dx = 0, dy = 0) => {
		router.endPinch(event('pointerup'), { x: start.x + dx, y: start.y + dy });
		const hold = overlay.panAnchorHold; router.touchPos.clear(); sample('immediate'); await settle(8); sample('settled');
		// `settled` is 8 frames after the lift, inside the 500 ms ease under the canvas. Read the rest once it has ended.
		for (let f = 0; f < 90 && overlay.overscrollBounceReadout && overlay.overscrollBounceReadout().active; f++) await frame();
		sample('arrived');
		return { outcome: hold?.outcome, held: !!overlay.panAnchorHold };
	};
	try {
		// Initial navigation establishes the zoom, then all saturation/reversal
		// samples pass through the production pinch router and its real callback.
		overlay.commitCameraScale(.25, { left: 0, top: 0 }); await settle(8);
		for (let i = 0; i < 3; i++) { await begin(); move(400, mode === 'corner' ? 700 : 0, 450); await frame(); await end(mode === 'corner' ? 700 : 0, 450); }
		await begin();
		// Corner activation can consume X travel. Establish the boundary with
		// real input before measuring another outward move and immediate reversal.
		// A GESTURE-START SAMPLE, so `before` can be read as a law instead of a literal. `before` is taken
		// with the fingers ALREADY DOWN, and on the corner arm after a (650, 400) move, so it is a preview
		// position and not a rest. Recording where the gesture began lets the cell assert that the page
		// followed the fingers to it, from the fixture's own inputs.
		const startSample = sample('start');
		if (mode === 'corner') { move(400, 650, 400); await frame(); }
		const before = sample('before');
		const anchor = overlay.pinchAnchor;
		const frozen = () => JSON.stringify([anchor.focalX, anchor.focalY, anchor.hostLeft, anchor.hostTop, anchor.columnLocal, anchor.contentTopLocal, anchor.fromScale, overlay.pinchRefScale]);
		const initialAnchor = frozen();
		if (mode === 'scale' || mode === 'mixed') {
			move(200, 0, mode === 'mixed' ? 100 : 0); sample('queued-out');
			move(400, 0, mode === 'mixed' ? 25 : 0); sample('queued-back');
		} else {
			move(400, mode === 'corner' ? 700 : 0, 450); sample('queued-out');
			move(400, mode === 'corner' ? 625 : 0, 375); sample('queued-back');
		}
		const anchorUnchanged = frozen() === initialAnchor;
		if (mode !== 'pending') await frame();
		const last = sample('last');
		const release = await end(mode === 'corner' ? 625 : 0, mode === 'mixed' ? 25 : mode === 'scale' ? 0 : 375);
		return { mode, infiniteCanvas, before, last, rows, release, anchorUnchanged, start: startSample, naturalLeftBoundary: view.dom.getBoundingClientRect().left + naturalLeft * overlay.pinchScaleNow };
	} finally { view.destroy(); pane.remove(); }
}

/** Compare the owned column with a separate ordinary 100% editor. Named
 * uncertainty: do resize/theme refresh preserve the CURRENT natural margin,
 * including fixed-left/RLL-off and an externally scaled host?
 */
/**
 * THE UNITY-ZOOM MEASUREMENT GUARD. Every write of `viewportLayout.columnLocal`
 * after takeover is recorded with the host's inline `zoom` at that instant and
 * the base inline zoom the layout saved at takeover. The natural column must be
 * measured with the plugin's zoom off: under the zoom host the theme's auto
 * margin resolves in a mixed basis and reads 7.5 (1/k - 1) local px short.
 * Installed synchronously after the takeover commit, so the first re-measure
 * (a rAF later) is already watched. The takeover's own value is not watched
 * here: it is read before the overlay writes anything, from the rect, and
 * runFocal's `takeover` field pins it against the page's own rect read.
 */
function watchColumnLocal(rig: { overlay: any; view: EditorView }) {
	const writes: { value: number | null; styleZoom: string; base: string; classOn: boolean }[] = [];
	const layout = rig.overlay.viewportLayout;
	if (!layout) return { installed: false, writes };
	const base = layout.styles?.get?.("zoom")?.value ?? "";
	let value = layout.columnLocal;
	Object.defineProperty(layout, "columnLocal", {
		configurable: true, enumerable: true, get: () => value,
		set: (next: number | null) => { writes.push({ value: next, styleZoom: rig.view.dom.style.zoom, base, classOn: rig.view.dom.classList.contains("handwriting-note-viewport") }); value = next; },
	});
	return { installed: true, writes };
}

/**
 * THE VIEWPORT STYLE OBSERVER AND THE OVERLAY'S OWN CLASS. The observer watches
 * the pane's class for theme changes; the overlay adds its own pane class on
 * the first owned box write. That addition must not read as a theme change:
 * it scheduled a style refresh (a forced layout) after every takeover, and a
 * refresh that re-commits retires a pending pinch settle. Three reads:
 * - `plain`: takeover plus two plain commits, then frames; counts of scheduled
 *   refreshes, refreshes run, and commits made from inside a refresh;
 * - `forced`: a refresh called directly with nothing changed; commits from it;
 * - `theme`: POSITIVE CONTROL, the line width changed on the body; the refresh
 *   must run and re-commit, so a zero above is a reading and not a dead observer.
 */
async function runViewportStyleObserver() {
	const rig = await mount('style-observer', true, false);
	const o = rig.overlay as any;
	const counts = { schedule: 0, refresh: 0, commitsInRefresh: 0 };
	let inRefresh = false;
	const schedule = o.scheduleViewportStyleRefresh, refresh = o.refreshViewportColumn, commit = o.commitCameraScale;
	o.scheduleViewportStyleRefresh = function (...a: unknown[]) { counts.schedule++; return schedule.apply(this, a); };
	o.refreshViewportColumn = function (...a: unknown[]) { counts.refresh++; inRefresh = true; try { return refresh.apply(this, a); } finally { inRefresh = false; } };
	o.commitCameraScale = function (...a: unknown[]) { if (inRefresh) counts.commitsInRefresh++; return commit.apply(this, a); };
	const snap = () => ({ ...counts });
	try {
		await settle(10);
		o.syncCamera();
		o.commitCameraScale(.5, { left: 0, top: 0 });
		await settle(10);
		o.commitCameraScale(.25, { left: 0, top: 0 });
		await settle(10);
		const plain = { ...snap(), owned: !!o.viewportLayout, scale: o.pinchScaleNow, paneClassHasOwn: rig.pane.classList.contains('handwriting-note-viewport-pane') };
		const before = snap();
		const ran = o.refreshViewportColumn();
		await settle(4);
		const forced = { ran, refresh: counts.refresh - before.refresh, commitsInRefresh: counts.commitsInRefresh - before.commitsInRefresh };
		const beforeTheme = snap();
		document.body.style.setProperty('--file-line-width', '500px');
		await settle(14);
		const theme = { schedule: counts.schedule - beforeTheme.schedule, refresh: counts.refresh - beforeTheme.refresh, commitsInRefresh: counts.commitsInRefresh - beforeTheme.commitsInRefresh };
		return { plain, forced, theme };
	} finally { document.body.style.removeProperty('--file-line-width'); rig.view.destroy(); rig.pane.remove(); }
}

/** POSITIVE CONTROL for the guard: a write planted while the plugin's zoom is on the host must be recorded as one. */
async function runColumnLocalGuardPlant() {
	const rig = await mount('column-guard-plant', true, false);
	try {
		await settle(10);
		rig.overlay.syncCamera();
		rig.overlay.commitCameraScale(.5, { left: 0, top: 0 });
		const guard = watchColumnLocal(rig);
		const zoomAtPlant = rig.view.dom.style.zoom;
		rig.overlay.viewportLayout.columnLocal = 123.5;
		return { installed: guard.installed, zoomAtPlant, writes: guard.writes.slice(0, 1) };
	} finally { rig.view.destroy(); rig.pane.remove(); }
}

async function runColumnChanges(readable: boolean, infiniteCanvas: boolean, external: number, selfAligned = false) {
	const reference = await mount('column-reference', readable, infiniteCanvas);
	const rig = await mount('column-owned', readable, infiniteCanvas);
	for (const r of [reference, rig]) {
		r.pane.style.position = 'absolute'; r.pane.style.top = '0';
		r.pane.style.transform = `scale(${external})`; r.pane.style.transformOrigin = '0 0';
		if (selfAligned) {
			Object.assign(r.view.contentDOM.parentElement!.style, { display: 'flex', flexDirection: 'column', alignItems: 'stretch', paddingLeft: '17.25px' });
			Object.assign(r.view.contentDOM.style, { alignSelf: 'center', width: '300px' });
		}
	}
	await settle(10);
	rig.overlay.syncCamera();
	rig.overlay.commitCameraScale(.5, { left: 0, top: 0 });
	const guard = watchColumnLocal(rig);
	await settle(10);
	// The column's LAYOUT origin, without the overlay's pan: this cell pins the frozen margin's re-measure. Since 1.4.20
	// a commit also lands a centred column's rest as pan (landColumnRest), which moves the painted column and is
	// pinned in RllColumnFocalHold; the reference is never zoomed and stands no pan, so taking the pan out keeps the two
	// in one frame (a pan of 0 with the setting off, as before).
	const origin = (r: typeof rig, scale: number) => ((contentOriginLeft(r.view.contentDOM) ?? NaN) - r.view.dom.getBoundingClientRect().left - (r.overlay?.panX?.() ?? 0)) / scale + r.view.scrollDOM.scrollLeft;
	const samples: unknown[] = [];
	const record = (phase: string) => {
		rig.overlay.syncCamera();
		const col = contentOriginLeft(rig.view.contentDOM)!;
		const expectedCamera = (rig.overlay.container.getBoundingClientRect().left - col + rig.overlay.panX()) / rig.overlay.scale;
		samples.push({ phase, expected: origin(reference, external), actual: origin(rig, external * .5), frozen: rig.overlay.viewportLayout.columnLocal,
			layoutColumn: rig.overlay.ownedColumnLayoutLeft(rig.view.contentDOM.querySelector('.cm-line')), cameraError: rig.overlay.camera.x - expectedCamera });
	};
	try {
		record('initial');
		for (const r of [reference, rig]) r.pane.style.width = `${PANE_W + 200}px`;
		reference.view.dom.style.width = `${PANE_W + 200}px`;
		await settle(14); record('wider');
		document.body.style.setProperty('--file-line-width', '500px');
		await settle(14); record('theme-cap');
		return { readable, infiniteCanvas, external, samples, guardInstalled: guard.installed, columnLocalWrites: guard.writes };
	} finally { reference.view.destroy(); rig.view.destroy(); reference.pane.remove(); rig.pane.remove(); }
}

/**
 * THE AUTO TERM, as a number. applyViewportBox writes Readable line length's
 * auto-centring term as `--handwriting-column-auto-left` instead of letting the
 * engine resolve a percentage under css zoom. The read: at 100%, owned, the
 * written term against the engine's own centring of an UNOWNED editor in the
 * same pane (the control that the number is the one the percentage used to
 * produce).
 */
async function runColumnAutoControl(external: number) {
	const reference = await mount('auto-reference', true, false);
	const rig = await mount('auto-owned', true, false);
	for (const r of [reference, rig]) {
		r.pane.style.position = 'absolute'; r.pane.style.top = '0';
		r.pane.style.transform = `scale(${external})`; r.pane.style.transformOrigin = '0 0';
	}
	await settle(10);
	try {
		rig.overlay.syncCamera();
		rig.overlay.commitCameraScale(.5, { left: 0, top: 0 });
		await settle(10);
		rig.overlay.commitCameraScale(1, { left: 0, top: 0 });
		await settle(10);
		const sizerOf = (r: typeof rig) => r.view.dom.querySelector('.cm-sizer') as HTMLElement;
		const autoText = rig.view.dom.style.getPropertyValue('--handwriting-column-auto-left');
		const at100 = {
			owned: !!rig.overlay.ownsNoteViewport(), scale: rig.overlay.pinchScaleNow, autoText,
			autoLeft: autoText ? Number.parseFloat(autoText) : null,
			engineLeft: Number.parseFloat(getComputedStyle(sizerOf(reference)).marginLeft),
			ownedLeft: Number.parseFloat(getComputedStyle(sizerOf(rig)).marginLeft),
			columnX: contentOriginLeft(rig.view.contentDOM),
		};
		return { external, at100, hostZoom: rig.overlay.hostZoomSupported() as boolean, engineZoom: CSS.supports("zoom", "0.5") };
	} finally { reference.view.destroy(); rig.view.destroy(); reference.pane.remove(); rig.pane.remove(); }
}

/** Repeated scroll-right then pen input, with display frames BETWEEN samples.
 * Named uncertainty: does raster allocation/work or deferred work grow while
 * the visible viewport stays fixed? Counts decide whether a rendering fix is
 * justified; timings describe this browser only. Saved bytes and committed
 * blue pixels are checked separately from the timed event handlers.
 */
async function runScrollDraw(zoom: number, scroll: boolean, infiniteCanvas: boolean, cadence: "immediate" | "frame" | "settled", cycles = 24, ending?: "abandon" | "switch" | "destroy") {
	const rig = await mount(`scroll-draw-${zoom}-${scroll}-${infiniteCanvas}-${cadence}`, true, infiniteCanvas);
	const { view, pane, overlay, path } = rig;
	const scroller = view.scrollDOM, pr = pane.getBoundingClientRect();
	drawAt(view, (contentOriginLeft(view.contentDOM) ?? pr.left) + 80, pr.top + 180, 991);
	await settle(8);
	// Real synthetic stored ink supplies a scrollable range at 10% zoom.
	// A viewport-only page is a dead scroll control after zooming out.
	const seed = inlineInk.strokes(path)[0]!;
	inlineInk.commit(path, { ...seed, id: 'far-right-seed',
		points: seed.points.map(p => ({ ...p, x: p.x + 90000 })),
		bbox: { ...seed.bbox, x: seed.bbox.x + 90000 } });
	const seedCount = inlineInk.strokes(path).length;
	const original = JSON.stringify(inlineInk.strokes(path));
	pickStripColor('Blue', '#0000ff');
	if (!overlay.commitCameraScale(zoom, { left: 0, top: 0 })) throw new Error('zoom refused');
	await new Promise(r => setTimeout(r, 150)); await settle(8);
	const blank = () => ({ resize: 0, repaint: 0, extent: 0, band: 0, reallocations: 0, wetReallocations: 0, allocatedPixels: 0, clearCalls: 0, clearArea: 0, fills: 0, pathCommands: 0, rectReads: 0, rafRequests: 0, maxPendingRaf: 0, eventMs: 0, methods: {} as Record<string, number> });
	let counts = blank(), active = true;
	const pendingRaf = new Set<number>();
	let destroyed = false;
	const rows: any[] = [], originals = new Map<string, (...args: any[]) => any>();
	for (const [name, key] of [['handleResize','resize'],['repaint','repaint'],['updateExtent','extent'],['syncBand','band']] as const) {
		const fn = overlay[name]; originals.set(name, fn);
		overlay[name] = function (...args: any[]) { const t = performance.now(); if (active) counts[key]++; try { return fn.apply(this, args); } finally { if(active)counts.methods[name] = (counts.methods[name] ?? 0) + performance.now() - t; } };
	}
	const rect = Element.prototype.getBoundingClientRect;
	Element.prototype.getBoundingClientRect = function () { if(active)counts.rectReads++; return rect.call(this); };
	const raf = window.requestAnimationFrame.bind(window), cancelRaf = window.cancelAnimationFrame.bind(window);
	window.requestAnimationFrame = callback => {
		const id = raf(t => { pendingRaf.delete(id); callback(t); });
		if (active) { counts.rafRequests++; pendingRaf.add(id); counts.maxPendingRaf = Math.max(counts.maxPendingRaf, pendingRaf.size); }
		return id;
	};
	window.cancelAnimationFrame = id => { pendingRaf.delete(id); cancelRaf(id); };
	const proto = HTMLCanvasElement.prototype;
	const dimensions = ['width','height'].map(key => [key, Object.getOwnPropertyDescriptor(proto,key)!] as const);
	for (const [key,d] of dimensions) Object.defineProperty(proto,key,{...d,set(value:number){ if(active && view.dom.contains(this)){counts.reallocations++;if(this===overlay.wetCanvas)counts.wetReallocations++;counts.allocatedPixels+=key==='width'?value*this.height:value*this.width;}d.set!.call(this,value);}});
	const ctxProto=CanvasRenderingContext2D.prototype;
	const clear=ctxProto.clearRect, fill=ctxProto.fill, line=ctxProto.lineTo, curve=ctxProto.bezierCurveTo;
	ctxProto.clearRect=function(...args:Parameters<typeof clear>){if(active && view.dom.contains(this.canvas)){counts.clearCalls++;counts.clearArea+=Math.abs(args[2]*args[3]);}return clear.apply(this,args);};
	ctxProto.fill=function(...args:any[]){if(active && view.dom.contains(this.canvas))counts.fills++;return (fill as any).apply(this,args);};
	ctxProto.lineTo=function(...args:Parameters<typeof line>){if(active && view.dom.contains(this.canvas))counts.pathCommands++;return line.apply(this,args);};
	ctxProto.bezierCurveTo=function(...args:Parameters<typeof curve>){if(active && view.dom.contains(this.canvas))counts.pathCommands++;return curve.apply(this,args);};
	const pen=(type:string,x:number,y:number,pressure:number,t:number)=>{
		const target=document.elementFromPoint(x,y);
		if(!target || !scroller.contains(target))throw new Error('pen outside scroller');
		const event=new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:'pen',pointerId:992,isPrimary:true,clientX:x,clientY:y,pressure,buttons:type==='pointerup'?0:1});
		Object.defineProperty(event,'timeStamp',{value:t});
		const start=performance.now();target.dispatchEvent(event);counts.eventMs+=performance.now()-start;
	};
	const blueAt=(x:number,y:number,red:number)=>{
		const canvas=overlay.committedCanvas as HTMLCanvasElement, r=rect.call(canvas), bx=canvas.width/r.width,by=canvas.height/r.height;
		const inside = x-10>=r.left && x+90<=r.right && y-20>=r.top && y+45<=r.bottom;
		const thirds = [0,0,0];
		// Never clamp an off-canvas target onto unrelated pixels at the edge.
		if (!inside) return { pixels: 0, thirds, inside };
		const left=Math.floor((x-r.left-10)*bx),top=Math.floor((y-r.top-20)*by);
		const width=Math.min(canvas.width-left,Math.ceil(100*bx)),height=Math.min(canvas.height-top,Math.ceil(65*by));
		const data=canvas.getContext('2d')!.getImageData(left,top,width,height).data;
		for(let i=0;i<data.length;i+=4) {
			if(data[i+3]!<40 || Math.abs(data[i]!-red)>3 || data[i+1]!>3 || data[i+2]!<252) continue;
			const screenX = r.left + (left + (i/4)%width)/bx;
			thirds[screenX<x+24?0:screenX<x+48?1:2]!++;
		}
		return {pixels:thirds.reduce((a,b)=>a+b,0),thirds,inside};
	};
	try {
		for(let i=0;i<cycles;i++) {
			// Each contact has a distinct color; previous ink cannot satisfy it.
			const red = i*8;
			pickStripColor('Probe', `#${red.toString(16).padStart(2,'0')}00ff`);
			counts=blank();saveCost={calls:0,ms:0,bytes:0};
			// Whether the wet canvas was already released when the cycle began, and when its pen-down came.
			const wetReleasedAtStart=overlay.wetDeferred===true;
			const before=scroller.scrollLeft;
			if(scroll)scroller.scrollLeft+=240/zoom;
			if(cadence==='frame')await frame();
			if(cadence==='settled')await settle(8);
			const wetReleasedBeforeDraw=overlay.wetDeferred===true;
			const x=pr.left+pr.width*.65,y=pr.top+100+i*25,t=performance.now();
			pen('pointerdown',x,y,.2,t);
			for(let j=1;j<=4;j++){await frame();pen('pointermove',x+j*16,y+Math.sin(j)*12,.2+j*.15,t+j*16);}
			pen('pointerup',x+72,y,.8,t+80);
			const inputWork=structuredClone(counts);
			const immediateBlue=blueAt(x,y,red);
			await frame();
			const canvas=overlay.committedCanvas as HTMLCanvasElement;
			rows.push({cycle:i,wetReleasedAtStart,wetReleasedBeforeDraw,scrollBefore:before,scrollAfter:scroller.scrollLeft,grant:surfaceExtents.get(path),viewport:{width:scroller.clientWidth,height:scroller.clientHeight},backing:{width:canvas.width,height:canvas.height},inputWork,work:structuredClone(counts),save:{...saveCost},bandRect:rect.call(canvas).toJSON(),immediateBlue,frameBlue:blueAt(x,y,red),strokes:inlineInk.strokes(path).length,queued:overlay.repaintQueued});
		}
		await settle(8);
		let lifecycle: any = null;
		if (ending) {
			const beforeInk = JSON.stringify(inlineInk.strokes(path)), beforeSaved = sidecars.get(ids.get(path)!);
			// A SMALL scroll, inside the band's coverage. The deferral this
			// lifecycle guards now exists only while the band still covers the
			// viewport: a scroll that takes the viewport past the band edge is
			// carried under the locked frame instead (carryBandUnderLock, the
			// far-mark-immediate arm), and would leave nothing deferred to clear.
			// 240 visual px used to sit here and did exactly that at 0.1.
			scroller.scrollLeft += 40/zoom;
			const x=pr.left+pr.width*.65,y=pr.top+300,t=performance.now();
			pen('pointerdown',x,y,.2,t);
			await settle(2);
			const beforeDeferred=!!overlay.bandSyncDeferred;
			if (ending==='abandon') {
				// Exercise the production finger-cancellation handler body after
				// revoking the router contact, as its real caller does.
				overlay.router.abandonActiveStroke();
				overlay.cancelFingerInkForPinch();
			} else if (ending==='switch') {
				// A switch hands the view a different file object; the same object with a new path is a rename.
				(view.state.field(editorInfoField) as any).file = { path: `${path}-next.md` };
				view.dispatch({});
			} else { view.destroy(); destroyed=true; }
			const afterResetDeferred=!!overlay.bandSyncDeferred;
			await settle(8);
			const r=overlay.container ? rect.call(overlay.container) : null;
			lifecycle={ending,beforeDeferred,afterResetDeferred,afterDeferred:!!overlay.bandSyncDeferred,locked:overlay.frame.locked,queued:overlay.repaintQueued,
				covered:r!==null && r.left<=pr.left && r.right>=pr.right,
				mounted:!!overlay.container,unchangedMemory:JSON.stringify(inlineInk.strokes(path))===beforeInk,unchangedSidecar:sidecars.get(ids.get(path)!)===beforeSaved};
		}
		const strokes=inlineInk.strokes(path), stored=sidecars.get(ids.get(path)!)!;
		const parsed=parsePage(stored,ids.get(path)!).data;
		const roundtrip = parsed.strokes.length===strokes.length && strokes.every((s,i)=>{
			const saved=parsed.strokes[i]!;
			return saved.id===s.id && saved.tool===s.tool && saved.color===s.color && Math.abs(saved.width-s.width)<=.000501 && saved.points.length===s.points.length && s.points.every((p,j)=>{
				const q=saved.points[j]!;
				return Math.abs(p.x-q.x)<=.005001 && Math.abs(p.y-q.y)<=.005001 && Math.abs(p.pressure-q.pressure)<=.000501 && Math.abs(p.t-q.t)<=.500001;
			});
		});
		return {zoom,scroll,infiniteCanvas,cadence,cycles,seedCount,roundtrip,lifecycle,rows,strokes:strokes.length,savedStrokes:parsed.strokes.length,originalUnchanged:JSON.stringify(strokes.slice(0,seedCount))===original,idsUnique:new Set(strokes.map(s=>s.id)).size===strokes.length,points:strokes.slice(seedCount).map(s=>({count:s.points.length,pressures:s.points.map(p=>p.pressure),finite:s.points.every(p=>[p.x,p.y,p.pressure,p.t].every(Number.isFinite))})),pendingRaf:pendingRaf.size,bandSyncDeferred:!!overlay.bandSyncDeferred,queued:overlay.repaintQueued};
	}finally{
		active=false;saveCost=null;
		for(const [name,fn] of originals)overlay[name]=fn;
		Element.prototype.getBoundingClientRect=rect;window.requestAnimationFrame=raf;window.cancelAnimationFrame=cancelRaf;
		for(const [key,d] of dimensions)Object.defineProperty(proto,key,d);
		ctxProto.clearRect=clear;ctxProto.fill=fill;ctxProto.lineTo=line;ctxProto.bezierCurveTo=curve;
		if(!destroyed)view.destroy();pane.remove();
	}
}

/** Cancellation gate for an explicitly owned public scroll target. The
 * request and its mapped receipt use public effect/selection APIs only.
 * Actual CM handler values decide whether identity or shape can distinguish
 * a canceled owned request from a later legitimate foreign request.
 */
async function runOwnedRequestCancellation(mode: "unchanged" | "mapped" | "foreign" | "editOnly" | "deleteWhole" | "replaceWhole" | "multiple" | "newBinding" | "cancelAfterMap" | "newInput" | "foreignAfterMap" | "clipForeign" | "staleBounds") {
	const rig = await mount(`owned-request-${mode}`, true, false, "missing");
	const { view, pane, overlay } = rig, scroller = view.scrollDOM;
	scroller.scrollTop = 2000;
	await settle(10);
	const rect = scroller.getBoundingClientRect();
	const position = view.posAtCoords({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, false) ?? view.viewport.from;
	const requestOptions = { x: 'nearest' as const, y: 'start' as const, xMargin: 0, yMargin: 0 };
	let mappedRange = EditorSelection.cursor(position);
	const owner = { cancelled: mode !== "cancelAfterMap" && mode !== "newInput" };
	if (mode === "staleBounds") {
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'short' }, filter: false });
		const refused = overlay.ownScrollRange(mappedRange, owner) === null;
		view.destroy(); pane.remove(); return { mode, position, refused };
	}
	const publicValue = (r: any) => ({ from: r.from, to: r.to, anchor: r.anchor, head: r.head, empty: r.empty, assoc: r.assoc, bidiLevel: r.bidiLevel, goalColumn: r.goalColumn, json: r.toJSON() });
	const semantics: unknown[] = [];
	for (const original of [EditorSelection.cursor(position, 1, 2, 9), EditorSelection.range(position + 4, position - 3, 7, 1)]) {
		const wrapped = overlay.ownScrollRange(original, owner)!;
		const empty = view.state.changes([]), change = view.state.changes({ from: position, insert: 'x' });
		semantics.push({ original: publicValue(original), wrapped: publicValue(wrapped), equal: wrapped.eq(original, true), unchangedIdentity: wrapped.map(empty) === wrapped, originalUntagged: !overlay.scrollRangeOwners.has(original), samePrototype: Object.getPrototypeOf(wrapped) === Object.getPrototypeOf(original), extendEqual: wrapped.extend(position - 10, position + 12).eq(original.extend(position - 10, position + 12), true) });
		for (const args of [[change], [change, -1], [change, 1]] as const) {
			const expected = Reflect.apply(original.map, original, args), actual = Reflect.apply(wrapped.map, wrapped, args);
			semantics.push({ original: publicValue(expected), wrapped: publicValue(actual), mappedOwned: overlay.scrollRangeOwners.get(actual) === owner });
		}
	}
	const ownedRange = overlay.ownScrollRange(mappedRange, owner);
	if (!ownedRange) throw new Error("relevant visible range was refused");
	const issued = EditorView.scrollIntoView(ownedRange, requestOptions);
	let mapped = issued;
	const observations: unknown[] = [];
	let foreignValue: unknown = null;
	const sameRange = (a: any, b: any) => a.anchor === b.anchor && a.head === b.head && a.assoc === b.assoc;
	view.dispatch({ effects: StateEffect.appendConfig.of([Prec.highest(EditorView.scrollHandler.of((_view, range, options) => {
		const originalIdentity = options === issued.value, mappedIdentity = options === mapped.value;
		const mappedShape = sameRange(range, mappedRange) && options.x === requestOptions.x && options.y === requestOptions.y && options.xMargin === requestOptions.xMargin && options.yMargin === requestOptions.yMargin;
		const rangeOwned = overlay.scrollRangeOwners.get(range) === owner;
		observations.push({ originalIdentity, mappedIdentity, mappedShape, rangeOwned, cancelled: owner.cancelled, foreignIdentity: options === foreignValue, head: range.head, beforeTop: scroller.scrollTop });
		// Recognized canceled requests are consumed with no writes. An
		// unrecognized request reaches actual default CM scrolling.
		return false;
	})),
	EditorView.scrollHandler.of((_view, range) => overlay.consumeViewportScroll(range))]) });
	await settle(4);
	const selectionBefore = view.state.selection.toJSON();
	const topBefore = scroller.scrollTop;
	if (mode !== "editOnly") view.dispatch({ effects: issued });
	const applyEdit = (changes: { from: number; to?: number; insert?: string }) => {
		const edit = view.state.update({ changes, filter: false });
		mapped = mapped.map(edit.changes)!; mappedRange = mappedRange.map(edit.changes);
		view.dispatch(edit);
	};
	if (mode !== 'unchanged' && mode !== 'newInput') {
		if (mode === 'deleteWhole') applyEdit({ from: 0, to: view.state.doc.length });
		else if (mode === 'replaceWhole' || mode === 'newBinding') {
			if (mode === 'newBinding') (view.state.field(editorInfoField) as any).file.path += '-next.md';
			applyEdit({ from: 0, to: view.state.doc.length, insert: 'replacement text\n'.repeat(400) });
		} else applyEdit({ from: 0, insert: 'inserted line\n' });
		if (mode === 'multiple') { applyEdit({ from: 0, insert: 'second insertion\n' }); applyEdit({ from: 0, to: 7 }); }
		if (mode === 'cancelAfterMap') owner.cancelled = true;
		if (mode === 'foreign' || mode === 'foreignAfterMap' || mode === 'clipForeign') {
			const foreignRange = mode === 'clipForeign' ? EditorSelection.cursor(view.state.doc.length + 100) : EditorSelection.cursor(mappedRange.head, mappedRange.assoc);
			const foreign = EditorView.scrollIntoView(foreignRange, requestOptions);
			foreignValue = foreign.value;
			view.dispatch({ effects: foreign, filter: false });
			if (mode === 'foreignAfterMap') applyEdit({ from: 0, insert: 'later edit\n' });
		}
	}
	let inputRevoked: boolean | null = null;
	if (mode === 'newInput') {
		// The real wheel callback revokes authority; range provenance must
		// survive that revocation so the pending request is still consumed.
		overlay.panAnchorHold = owner;
		scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }));
		inputRevoked = overlay.panAnchorHold !== owner; owner.cancelled = inputRevoked;
	}
	await settle(10);
	const result = { mode, position, semantics, inputRevoked, docLength: view.state.doc.length, binding: (view.state.field(editorInfoField) as any).file.path, viewport: view.viewport, observations, topBefore, topAfter: scroller.scrollTop, selectionBefore, selectionAfter: view.state.selection.toJSON(), docChanged: view.state.doc.toString().startsWith('inserted line') };
	view.destroy(); pane.remove(); return result;
}

/**
 * COMPOSITOR LAYER BOUNDS. Mount Alan's pane at 0.1, far or near, and leave it
 * mounted so the test can read the compositor's layer tree through CDP. The
 * five ink canvases carry a data attribute so the layers can be matched to
 * them by node. Teardown is a separate call.
 */
let layerBoundsRig: { view: EditorView; pane: HTMLElement } | null = null;
/**
 * A pinch preview torn down mid-gesture: the plugin's unmount must give
 * CodeMirror its measuring back (the view's own `requestMeasure` / `measure`
 * shadows gone) and, when the view outlives the plugin, CodeMirror must
 * measure again. 'destroy' tears the view down; 'remove' reconfigures the
 * overlay out of a living view.
 */
async function runPinchTeardown(mode: 'destroy' | 'remove') {
	const rig = await mount(`pinch-teardown-${mode}`, true, true);
	const { pane, view, overlay } = rig;
	const router = overlay.router, pr = pane.getBoundingClientRect();
	const focal = { x: pr.left + 400, y: pr.top + 300 };
	const touch = (spread: number) => { router.touchPos.set(801, { x: focal.x - spread / 2, y: focal.y }); router.touchPos.set(802, { x: focal.x + spread / 2, y: focal.y }); };
	const own = () => ({ requestMeasure: Object.prototype.hasOwnProperty.call(view, 'requestMeasure'), measure: Object.prototype.hasOwnProperty.call(view, 'measure') });
	const before = own();
	touch(400); router.beginPinch(new PointerEvent('pointerdown', { pointerId: 802, pointerType: 'touch' }));
	touch(480); router.updatePinch(new PointerEvent('pointermove', { pointerId: 802, pointerType: 'touch' }));
	await frame(); await frame();
	const preview = { pinchPreview: !!overlay.pinchPreview, own: own(), scale: overlay.pinchScaleNow };
	if (mode === 'destroy') view.destroy();
	else view.dispatch({ effects: rig.overlayCompartment.reconfigure([]), filter: false });
	const after = { own: own(), pinchPreview: !!overlay.pinchPreview };
	let measured = 0, measuresAgain = false;
	if (mode === 'remove') {
		// The release's own make-up measure runs in the next frame; after it,
		// a plain request must schedule CodeMirror's callback, which resolves
		// `this.measure` on the instance - counted here.
		await frame(); await frame();
		const realMeasure = (view as any).measure;
		Object.defineProperty(view, 'measure', { configurable: true, writable: true, value: function (this: any, flush?: boolean) { measured++; return realMeasure.call(this, flush); } });
		view.requestMeasure();
		await frame(); await frame(); await frame();
		measuresAgain = measured > 0;
		delete (view as any).measure;
		view.destroy();
	}
	pane.remove();
	return { mode, before, preview, after, measured, measuresAgain };
}
async function runLayerBoundsMount(far: boolean) {
 const {pane,view,overlay,path}=await mount(`layer-bounds-${far?'far':'near'}`,true,true,undefined,true);
 const scroller=view.scrollDOM;
 drawAt(view,contentOriginLeft(view.contentDOM)!+80,200,881);await settle(8);
 overlay.commitCameraScale(.1,{left:0,top:0});await settle(10);
 const shell=(pane.closest('.workspace-leaf')??pane) as HTMLElement;
 shell.style.width='973px';shell.style.height='704px';view.dom.style.width='973px';view.dom.style.height='704px';await settle(8);
 surfaceExtents.grow(path,{x:60000,y:60000});(overlay as any).updateExtent(true);await settle(10);
 if(far){scroller.scrollLeft=30000;scroller.scrollTop=30000;scroller.dispatchEvent(new Event('scroll',{bubbles:true}));await settle(10);}
 const names=['committedCanvas','highlightCanvas','wetCanvas','highlightWetCanvas','tailCanvas'] as const;
 const canvases=names.map(n=>{const c=overlay[n] as HTMLCanvasElement;c.setAttribute('data-hw-layer-probe',n);const r=c.getBoundingClientRect();const cs=getComputedStyle(c);return {name:n,backing:{w:c.width,h:c.height},css:{w:parseFloat(cs.width),h:parseFloat(cs.height)},transform:cs.transform,rect:{w:r.width,h:r.height}};});
 layerBoundsRig={view,pane};
 return {far,cssScale:overlay.cssScale,dpr:window.devicePixelRatio,scroll:{left:scroller.scrollLeft,top:scroller.scrollTop},client:{w:scroller.clientWidth,h:scroller.clientHeight},band:overlay.band?{...overlay.band}:null,container:{rect:overlay.container.getBoundingClientRect().toJSON(),css:{w:parseFloat(getComputedStyle(overlay.container).width),h:parseFloat(getComputedStyle(overlay.container).height)}},canvases};
}
async function runLayerBoundsTeardown() {
 if(!layerBoundsRig)return false;
 layerBoundsRig.view.destroy();layerBoundsRig.pane.remove();layerBoundsRig=null;await settle(4);return true;
}
/**
 * COMPOSITED PIXELS, NOT METADATA. The ink-vs-column arms above compare the ink
 * layer's rect against the column's rect. That is a claim about layout. What
 * Alan sees is the compositor's output, so this arm draws a magenta block at a
 * known column-relative note x, drives a real two-contact pinch through the
 * router, and at every preview frame and every settle asks the test side for a
 * CDP screenshot of a strip across the pane. The expected block centre comes
 * from layout at the same frame: the column's painted left edge plus the
 * block's note-space centre times the column's painted scale
 * (painted width over layout width), so no overlay field is part of the oracle.
 *
 * Phases, in one mount: rest at 100%; zoom OUT 1 -> 0.1; a scroll at 10%; zoom
 * IN 0.1 -> 1; a known 20 px layer shift (positive control); zoom IN 1 -> 2,
 * where the column freeze's clamp lifts and the preview offset is live again.
 *
 * Each frame records the state it depends on before and after the capture, so
 * a frame whose raster or transform changed while the screenshot was taken is
 * flagged rather than silently counted.
 */
async function runPixelColumn(readable: boolean, infiniteCanvas: boolean, backing = false, options: { external?: number; riseAt?: number; risePx?: number; pauseAt?: number[]; pauseAction?: "stroke" | "resize" | "font" | "watchdog" | "host"; shiftPlant?: number } = {}) {
	const shot = (window as any).__scpShot as ((clip: { x: number; y: number; width: number; height: number }) => Promise<{ ms: number; index: number }>) | undefined;
	if (!shot) throw new Error("runPixelColumn needs the test-side __scpShot binding");
	const rig = await mount(`pixels-${readable ? "rll" : "full"}-${infiniteCanvas ? "ic" : "noic"}`, readable, infiniteCanvas);
	const { view, overlay, pane, sizer, path } = rig;
	const scroller = view.scrollDOM;
	// EXTERNAL SCALE: an ancestor transform the note viewport does not own
	// (an app zoom). The same driver the boundary and column arms use.
	if (options.external && options.external !== 1) { pane.style.transform = `scale(${options.external})`; pane.style.transformOrigin = "0 0"; overlay.handleResize(); await settle(8); }
	// ROOM FOR A SCROLL RISE. A held zoom-out shrinks the reachable range and
	// the browser clamps scrollLeft, so a rise written mid-preview must have
	// granted surface to scroll into or it silently does nothing (measured:
	// scrollLeft 52 before and after a +60 write at k 0.45 without this).
	if (options.risePx) { surfaceExtents.grow(path, { x: 4000, y: 0 }); (overlay as any).updateExtent(true); await settle(10); }
	// CALLER EVIDENCE: count the production writers while the real router drives
	// the gesture, and keep the first stack so the chain is read, not assumed.
	const proto = InkOverlayPluginProto() as any;
	const calls = { applyPreviewInkOffset: 0, writeInkLayerTransform: 0, pinch: 0 };
	// RESIZES, counted and timed on the instance: a resize-driven reallocation
	// under a preview is the D-COV path; a frame records whether it fired.
	let resizes = 0, lastResizeAt = 0, repaints = 0, lastRepaintAt = 0, deferArms = 0;
	const realResize = (overlay as any).handleResize, realRepaint = (overlay as any).repaint, realArm = (overlay as any).armDeferredRepaint;
	let resizesPastGuard = 0;
	(overlay as any).handleResize = function (this: unknown, ...a: unknown[]) { resizes++; if (!(overlay as any).deferPinchRaster()) resizesPastGuard++; lastResizeAt = Math.round(performance.now()); return realResize.apply(this, a); };
	(overlay as any).repaint = function (this: unknown, ...a: unknown[]) { repaints++; lastRepaintAt = Math.round(performance.now()); return realRepaint.apply(this, a); };
	(overlay as any).armDeferredRepaint = function (this: unknown, ...a: unknown[]) { deferArms++; return realArm.apply(this, a); };
	// Two stacks, because the preview is coalesced to a frame: the router's
	// move reaches `pinch` synchronously, and `applyPreviewInkOffset` runs later
	// from that frame's `flushPinch` -> `applyPinchScale`.
	let applyStack = "", pinchStack = "", writeStack = "";
	const wrap = (name: keyof typeof calls, onCall?: () => void) => {
		const orig = proto[name];
		proto[name] = function (this: unknown, ...a: unknown[]) { calls[name]++; onCall?.(); return orig.apply(this, a); };
		return () => { proto[name] = orig; };
	};
	const unwrap = [
		wrap("applyPreviewInkOffset", () => { if (!applyStack) applyStack = new Error().stack ?? ""; }),
		wrap("writeInkLayerTransform", () => { if (!writeStack) { const s = new Error().stack ?? ""; if (s.includes("applyPreviewInkOffset")) writeStack = s; } }),
		wrap("pinch", () => { if (!pinchStack) pinchStack = new Error().stack ?? ""; }),
	];
	const MAGENTA = "#ff00ff";
	setInlineTool("pen"); setInkColorHex("pen", MAGENTA); setInkSizeMult("pen", 4);
	const paneRect = pane.getBoundingClientRect();
	const colLeft0 = contentOriginLeft(view.contentDOM) ?? paneRect.left;
	const hostLeft0 = view.dom.getBoundingClientRect().left;
	const settings = {
		paneReadableClass: pane.classList.contains("is-readable-line-width"),
		fileLineWidth: getComputedStyle(document.body).getPropertyValue("--file-line-width").trim(),
		sizerMaxWidth: getComputedStyle(sizer).maxWidth,
		columnFromHostLeft: colLeft0 - hostLeft0,
		paneWidth: paneRect.width,
		columnLayoutWidth: view.contentDOM.offsetWidth,
		scrollExpansionRequested: infiniteCanvas,
		externalScale: overlay.viewportLayout?.externalScale ?? null, requestedExternal: options.external ?? 1,
		fontZoom: overlay.fontZoom,
		dpr: window.devicePixelRatio,
	};
	// THE MARK: 20 vertical strokes 3 px apart, 240 px tall, so it stays a solid
	// block of more than 5 device px even at 10%, where a 5x5 median would
	// erase a single pen line.
	let stamp = 0;
	const pen = (type: string, x: number, y: number, id: number, buttons: number) => {
		const target = document.elementFromPoint(x, y);
		if (!target || !scroller.contains(target)) throw new Error(`mark pen misses scroller: ${x},${y}`);
		const e = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: id, isPrimary: true, clientX: x, clientY: y, buttons, pressure: buttons ? 0.5 : 0 });
		stamp = Math.max(e.timeStamp, stamp + 1);
		Object.defineProperty(e, "timeStamp", { value: stamp });
		target.dispatchEvent(e);
	};
	// THE MARK LIVES AWAY FROM EVERY EDGE: about 2100 note px down (a scroll at
	// 100% first) and 450 note px into the column, so at 10% there is room above
	// and beside it to scroll, and zooming back in near it does not push it out of
	// the pane. A mark cut by a pane edge has a shifted centre, which reads as drift.
	scroller.scrollTop = 1800;
	scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
	await settle(10); await new Promise(r3 => setTimeout(r3, 300)); await settle(6);
	const colLeftDraw = contentOriginLeft(view.contentDOM) ?? paneRect.left;
	const markX0 = Math.round(colLeftDraw + 422), markY0 = Math.round(paneRect.top + 300);
	for (let i = 0; i < 20; i++) {
		const x = markX0 + i * 3;
		pen("pointerdown", x, markY0, 700 + i, 1);
		for (let y = markY0 + 20; y <= markY0 + 240; y += 20) pen("pointermove", x, y, 700 + i, 1);
		pen("pointerup", x, markY0 + 240, 700 + i, 0);
	}
	await settle(10);
	setInkSizeMult("pen", 1);
	const strokes = inlineInk.strokes(path);
	const xs = strokes.flatMap((s: any) => s.points.map((p: any) => p.x)), ys = strokes.flatMap((s: any) => s.points.map((p: any) => p.y));
	const note = { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2, halfW: (Math.max(...xs) - Math.min(...xs)) / 2, halfH: (Math.max(...ys) - Math.min(...ys)) / 2 };

	const layout = () => {
		const c = view.contentDOM, cr = c.getBoundingClientRect();
		const scale = c.offsetWidth > 0 ? cr.width / c.offsetWidth : NaN;
		const colX = contentOriginLeft(c);
		const padTop = parseFloat(getComputedStyle(c).paddingTop) || 0;
		const docTop = cr.top + padTop * scale;
		const expectedY = docTop + note.cy * scale;
		// THE TEXT ANCHOR FOR Y: the line the mark was drawn beside, found by its
		// text and carried by the painted scale. CodeMirror estimates unrendered
		// heights, so the content box top alone can disagree with the painted lines.
		// A READING ONLY: where the text lands depends on the machine's font metrics
		// (the Linux CI runner puts this line 144 px lower than Windows at k=2), while
		// the ink is painted at expectedY on both. The rig centres, picks its focal
		// point and plans its scroll from expectedY, the camera's box.
		const line = anchorLine ? lineRectByText(anchorLine.text) : null;
		const expectedYLine = anchorLine && line ? line.top + anchorLine.deltaNote * scale : null;
		return { scale, colX, expectedX: colX === null ? null : colX + note.cx * scale, expectedY, expectedYLine };
	};
	const lineRectByText = (text: string): DOMRect | null => {
		for (const el of Array.from(view.contentDOM.querySelectorAll(".cm-line"))) if (el.textContent === text) return el.getBoundingClientRect();
		return null;
	};
	let anchorLine: { text: string; deltaNote: number } | null = null;
	{
		const at = layout();
		let best: { el: Element; d: number } | null = null;
		for (const el of Array.from(view.contentDOM.querySelectorAll(".cm-line"))) {
			const r = el.getBoundingClientRect(), d = Math.abs((r.top + r.bottom) / 2 - at.expectedY);
			if (!best || d < best.d) best = { el, d };
		}
		if (best && best.el.textContent) anchorLine = { text: best.el.textContent, deltaNote: (at.expectedY - best.el.getBoundingClientRect().top) / at.scale };
	}
	const state = () => {
		const cam = overlay.lastPaintCam, cc = overlay.committedCanvas as HTMLCanvasElement, r = cc.getBoundingClientRect();
		return {
			layerT: (overlay.inkLayer as HTMLElement | null)?.style.transform ?? "", sizerT: sizer.style.transform,
			cam: cam ? `${cam.x.toFixed(3)},${cam.y.toFixed(3)},${cam.zoom}` : "null", backing: `${cc.width}x${cc.height}`,
			canvasLeft: Math.round(r.left * 100) / 100, canvasWidth: Math.round(r.width * 100) / 100,
			canvasTop: Math.round(r.top * 100) / 100, canvasHeight: Math.round(r.height * 100) / 100,
			// The overlay container's box and clip, the scroller's extents, and
			// the resize path's activity, for the coverage classification.
			clip: (() => { const el = overlay.container as HTMLElement | null; if (!el) return null; const cr = el.getBoundingClientRect(); return { overflow: el.style.overflow, left: Math.round(cr.left * 100) / 100, top: Math.round(cr.top * 100) / 100, width: Math.round(cr.width * 100) / 100, height: Math.round(cr.height * 100) / 100 }; })(),
			scrollW: scroller.scrollWidth, scrollH: scroller.scrollHeight, resizes, resizesPastGuard, lastResizeAt, repaints, lastRepaintAt, deferArms, deferred: !!overlay.repaintDeferredByPinch,
			pinchNow: overlay.pinchScaleNow, preview: !!overlay.pinchPreview, sl: scroller.scrollLeft, st: scroller.scrollTop, raf: overlay.pinchRaf,
		};
	};
	const backingRead = () => {
		const cc = overlay.committedCanvas as HTMLCanvasElement, w = cc.width, h = cc.height;
		if (!(w > 0 && h > 0)) return null;
		const d = cc.getContext("2d")!.getImageData(0, 0, w, h).data;
		let minX = Infinity, maxX = -1, n = 0;
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			if (d[i + 3]! > 200 && d[i]! > 200 && d[i + 1]! < 60 && d[i + 2]! > 200) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; }
		}
		if (!n) return { n, cx: null, rectMappedX: null };
		const r = cc.getBoundingClientRect(), cx = (minX + maxX + 1) / 2;
		return { n, cx, rectMappedX: r.left + cx * r.width / w };
	};
	const frames: any[] = [];
	const r2 = (n: number) => Math.round(n * 100) / 100;
	const lineLeftNear = (y: number) => {
		let best: { left: number; d: number } | null = null;
		for (const el of Array.from(view.contentDOM.querySelectorAll(".cm-line"))) {
			const r = el.getBoundingClientRect(), d = Math.abs((r.top + r.bottom) / 2 - y);
			if (!best || d < best.d) best = { left: r.left, d };
		}
		return best ? r2(best.left) : null;
	};
	const diag = (at: ReturnType<typeof layout>) => {
		const cursor = overlay.penCursorEl as HTMLElement | null, cr = cursor?.getBoundingClientRect();
		const layerRect = (overlay.inkLayer as HTMLElement | null)?.getBoundingClientRect();
		return {
			pan: overlay.viewportPan ? { x: overlay.viewportPan.x, y: overlay.viewportPan.y } : null,
			rasterPan: overlay.rasterPan ? { x: overlay.rasterPan.x, y: overlay.rasterPan.y } : null,
			layerLeft: layerRect ? r2(layerRect.left) : null, hostLeft: r2(view.dom.getBoundingClientRect().left),
			lineLeft: lineLeftNear(at.expectedY),
			cursor: cursor && cr ? { display: getComputedStyle(cursor).display, x: r2(cr.left), y: r2(cr.top), w: r2(cr.width) } : null,
		};
	};
	const shoot = async (phase: string, label: string) => {
		// A STILL FRAME FIRST: the coalesced pinch flush has run and two frames in
		// a row read the same state, so the capture does not race a flush.
		let prev = JSON.stringify(state()), still = 0, waited = 0;
		while (waited < 20 && (overlay.pinchRaf !== 0 || still < 2)) {
			await frame(); waited++;
			const s = JSON.stringify(state());
			still = s === prev && overlay.pinchRaf === 0 ? still + 1 : 0;
			prev = s;
		}
		// THE WHOLE PANE, so a mark that left the layout's expected position is
		// still in the image and is measured rather than reported absent.
		const pr = pane.getBoundingClientRect();
		const clip = { x: pr.left, y: pr.top, width: Math.min(pr.width, window.innerWidth - pr.left), height: Math.min(pr.height, window.innerHeight - pr.top) };
		let attempts = 0, at = layout(), before = state(), d0 = diag(at), taken = { ms: 0, index: -1 }, after = before;
		// A capture whose state changed underneath it is retaken, up to 3 times.
		for (;;) {
			attempts++;
			at = layout(); before = state(); d0 = diag(at);
			taken = await shot(clip);
			after = state();
			if (JSON.stringify(before) === JSON.stringify(after) || attempts >= 3) break;
			await frame(); await frame();
		}
		const cc = overlay.committedCanvas as HTMLCanvasElement;
		const stable = JSON.stringify(before) === JSON.stringify(after);
		frames.push({
			phase, label, clip, ms: taken.ms, shotIndex: taken.index, attempts, waitedFrames: waited, ...at, before, diag: d0,
			stable, after: stable ? undefined : after,
			markHalfW: note.halfW * at.scale, markHalfH: note.halfH * at.scale,
			texelDevice: cc.width > 0 ? (cc.getBoundingClientRect().width / cc.width) * window.devicePixelRatio : NaN,
			previewInkOffset: overlay.previewInkOffset, backing: backing ? backingRead() : undefined,
		});
	};
	const router = overlay.router;
	const touches = (c: { x: number; y: number }, ratio: number) => {
		router.touchPos.set(952, { x: c.x - 150 * ratio, y: c.y });
		router.touchPos.set(953, { x: c.x + 150 * ratio, y: c.y });
	};
	const touchEvent = (type: string) => new PointerEvent(type, { pointerId: 953, pointerType: "touch" });
	const quiet = async () => { await settle(8); await new Promise(r3 => setTimeout(r3, 300)); await settle(6); };
	// BRING THE MARK INTO VIEW before a gesture, by scrolling as a reader would.
	// Moving the scroll by dS moves painted content by -dS * scale. A bound the
	// browser refuses is fine; the frames assert the mark is in the pane.
	const centreMark = async () => {
		const at = layout(), pr = pane.getBoundingClientRect();
		if (at.expectedX === null || !(at.scale > 0)) return;
		const dx = at.expectedX - (pr.left + pr.width / 2), dy = at.expectedY - (pr.top + pr.height / 2);
		if (Math.abs(dy) > 40) scroller.scrollTop += dy / at.scale;
		if (Math.abs(dx) > 40 && scroller.scrollWidth > scroller.clientWidth) scroller.scrollLeft += dx / at.scale;
		await quiet();
	};
	const gesture = async (phase: string, ratios: number[]) => {
		await centreMark();
		const at = layout(), pr = pane.getBoundingClientRect();
		// THE FOCAL POINT KEEPS THE MARK WHOLE ON SCREEN at the gesture's target
		// scale, predicted from layout: the note point under the fingers holds
		// still and everything else scales about it.
		const g = ratios[ratios.length - 1]!;
		const mx = at.expectedX ?? pr.left + pr.width / 2, my = at.expectedY;
		const hw = (note.halfW + 8) * at.scale * g, hh = (note.halfH + 8) * at.scale * g;
		const inside = (v: number, lo: number, hi: number) => Math.min(hi - 2, Math.max(lo + 2, v));
		const fxs = [mx, (at.colX ?? mx) + 4, pr.left + 10, pr.left + pr.width / 2].map(v => inside(v, pr.left, pr.right));
		const fys = [my, pr.top + 10, pr.top + pr.height / 2].map(v => inside(v, pr.top, pr.bottom));
		const fitsX = (fx: number) => { const cx = fx + (mx - fx) * g; return cx - hw >= pr.left + 10 && cx + hw <= pr.right - 10; };
		const fitsY = (fy: number) => { const cy = fy + (my - fy) * g; return cy - hh >= pr.top + 10 && cy + hh <= pr.bottom - 10; };
		const c = { x: fxs.find(fitsX) ?? fxs[0]!, y: fys.find(fitsY) ?? fys[0]! };
		const predictedFits = fitsX(c.x) && fitsY(c.y);
		const applyBefore = calls.applyPreviewInkOffset;
		touches(c, 1); router.beginPinch(touchEvent("pointerdown"));
		for (const r of ratios) {
			touches(c, r); router.updatePinch(touchEvent("pointermove"));
			await frame();
			// THE STROKE TRIGGER GOES IN HERE, inside the quiet window the frame
			// just stamped, so the repaint it schedules meets deferPinchRaster and
			// takes the production arming path (armDeferredRepaint, then its
			// timer); the state before it is the pause frame's baseline.
			let armed: any = null;
			if (options.pauseAt?.includes(r) && options.pauseAction === "stroke") {
				armed = state();
				const src = inlineInk.strokes(path)[0] as any;
				const clone = { ...src, id: `pause-${phase}-${r}`, color: "#00ff00", points: src.points.map((p: any) => ({ ...p, x: p.x + 200 })), bbox: { ...src.bbox, minX: src.bbox.minX + 200, maxX: src.bbox.maxX + 200 } };
				view.dispatch({ effects: inkEffect.of({ type: "add", path, strokes: [clone] }) });
			}
			await shoot(phase, `${phase} r=${r} k=${overlay.pinchScaleNow.toFixed(3)}`);
			// A STILL HOLD past the pinch quiet window (120 ms): the deferred
			// repaint lapses here, and a resize-driven reallocation under the
			// preview (D-COV) can only happen here. The frame's `resizes`,
			// `backing` and `cam` say whether that path fired during the pause.
			if (options.pauseAt?.includes(r)) {
				const t0 = performance.now(), s0 = armed ?? state(); let measuresInDispatch: number | null = null;
				// THE TRIGGERS THE STILL HOLD LACKS: a stroke
				// committing during the preview (the pen-up landing as the
				// pinch begins) arms the deferred repaint, which runs after the
				// quiet window lapses; a 1 px host resize reaches handleResize
				// through the plugin's own ResizeObserver, outside the hold.
				if (options.pauseAction === "resize") {
					pane.style.height = `${pane.getBoundingClientRect().height + 1}px`;
				} else if (options.pauseAction === "font") {
					// The font route: a geometry update carrying a font-size
					// change reaches the plugin's update hook, whose resize would
					// commit the camera and release the hold INSIDE CodeMirror's
					// update. Counted here: measures entered while the dispatch
					// runs (must be 0), and the frames after read the outcome.
					pane.style.height = `${pane.getBoundingClientRect().height + 1}px`; view.dom.style.height = pane.style.height;
					// Counted on the hold's CAPTURED callable: the release
					// calls that, never the prototype property, so only this wrapper can
					// see a measure run inside the dispatch. Restored right after it.
					// One plain request held first, as CodeMirror's resize debounce
					// leaves one during a preview: a release with nothing held measures
					// nothing, and the route under test is the release's measure.
					view.requestMeasure();
					const entry = (overlay as any).measureHold?.entries?.find((e: any) => e.name === "measure"); const captured = entry?.callable; let inDispatch = 0;
					if (entry) entry.callable = function (this: any, flush?: boolean) { inDispatch++; return captured.call(this, flush); };
					// A DOCUMENT CHANGE RIDES IN THE SAME TRANSACTION: CodeMirror's
					// geometryChanged is docChanged || Geometry/Height flags, and a
					// theme change alone sets none of them synchronously (its heights
					// change at the next measure, which the hold holds), so without it
					// the update hook's font branch never runs during the dispatch.
					// A trailing empty line moves nothing on the mark's rows.
					try { view.dispatch({ changes: { from: view.state.doc.length, insert: "\n" }, effects: StateEffect.appendConfig.of(EditorView.theme({ ".cm-content": { fontSize: `${17 + Math.round(r)}px` } })) }); }
					finally { if (entry) entry.callable = captured; }
					measuresInDispatch = entry ? inDispatch : null;
				} else if (options.pauseAction === "host") {
					// Route i-a's one-line trigger: the HOST box
					// changes with no pane change, so the plugin's ResizeObserver
					// enters handleResize past the quiet window and finds nothing to
					// commit; without the guard it would reallocate from the
					// unpanned viewport under the hold.
					view.dom.style.height = `${parseFloat(view.dom.style.height || `${view.dom.getBoundingClientRect().height}`) + 1}px`;
				} else if (options.pauseAction === "watchdog") {
					// The lost-end watchdog's action, invoked directly (its bound is
					// 10 s): the preview settles in place and re-anchors. The pause
					// frame and the steps after it read whether the page moved.
					(overlay as any).rebasePinch();
				}
				await new Promise(r2 => setTimeout(r2, 300)); await frame();
				const pausedMs = Math.round(performance.now() - t0);
				// SHIFT PLANT: a leftover translate on the ink layer, the shape of the
				// e355b259 resize commit; the camera's box stays where it was.
				if (options.shiftPlant) { const layer = overlay.inkLayer as HTMLElement; layer.style.transform = `${layer.style.transform} translate(0px, ${options.shiftPlant}px)`.trim(); }
				await shoot(phase, `${phase} pause${pausedMs} r=${r} k=${overlay.pinchScaleNow.toFixed(3)}`);
				const last = frames[frames.length - 1];
				last.pause = { pausedMs, action: options.pauseAction ?? null, before: s0, fired: { resizesPastGuard: resizesPastGuard - s0.resizesPastGuard, resizeEntries: resizes - s0.resizes, repaints: repaints - s0.repaints, deferArms: deferArms - s0.deferArms, camChanged: last.before.cam !== s0.cam, backingChanged: last.before.backing !== s0.backing, measuresInDispatch, heldAfter: Object.prototype.hasOwnProperty.call(view, "measure") } };
			}
			// THE WHOLE VIEWPORT at the deep zoom-out steps: with the container's
			// clip lifted under the preview, nothing of the ink may show outside
			// the pane. Counted on the test side against the pane clip.
			if (phase === "out" && (r === 0.3 || r === 0.2)) {
				const vp = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
				const extra = await shot(vp);
				const last = frames[frames.length - 1];
				last.viewportShotIndex = extra.index; last.viewportClip = vp;
			}
			// A SCROLL RISE INSIDE THE HELD PREVIEW (Alan's direction): the
			// reader's scroll moves the content and the ink layer together,
			// left; the preview offset must not move the ink a second time.
			// Inside the pinch quiet window the scroll handler returns before
			// scheduling a repaint, so the stale offset, if any, stays on show.
			if (phase === "out" && options.riseAt === r && options.risePx) {
				scroller.scrollLeft += options.risePx; scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
				await frame();
				await shoot(phase, `${phase} rise+${options.risePx} k=${overlay.pinchScaleNow.toFixed(3)}`);
			}
		}
		router.endPinch(touchEvent("pointerup"), c); router.touchPos.clear();
		await settle(12);
		await new Promise(r2 => setTimeout(r2, 400));
		await settle(6);
		await shoot(`${phase}-settle`, `${phase} settle k=${overlay.pinchScaleNow.toFixed(3)}`);
		return { focal: c, predictedFits, applyCalls: calls.applyPreviewInkOffset - applyBefore, pinchNow: overlay.pinchScaleNow };
	};
	try {
		await quiet();
		await shoot("rest", "rest k=1");
		const out = await gesture("out", [0.9, 0.75, 0.6, 0.45, 0.3, 0.2, 0.15, 0.1]);
		// A SCROLL AT 10%, sampled every frame of it: three steps away and three
		// back on each live axis, sized so the mark stays inside the pane.
		await centreMark();
		const hScrollable = scroller.scrollWidth > scroller.clientWidth;
		const scrollStart = { left: scroller.scrollLeft, top: scroller.scrollTop };
		const at0 = layout(), pr0 = pane.getBoundingClientRect();
		// Content moves by -dS * scale. Toward lo needs dS > 0 (room to that edge
		// and scroll range left); toward hi needs dS < 0 (room, and scroll already
		// taken). Three steps of a third of the larger feasible travel, then back.
		const plan = (pos: number, lo: number, hi: number, half: number, cur: number, max: number) => {
			const minus = Math.min(pos - half - lo - 20, (max - cur) * at0.scale);
			const plus = Math.min(hi - pos - half - 20, cur * at0.scale);
			return minus >= plus ? { sign: 1, step: Math.max(0, Math.min(80, minus / 3)) } : { sign: -1, step: Math.max(0, Math.min(80, plus / 3)) };
		};
		const vy = plan(at0.expectedY, pr0.top, pr0.bottom, (note.halfH + 8) * at0.scale, scroller.scrollTop, scroller.scrollHeight - scroller.clientHeight);
		const vx = plan(at0.expectedX ?? pr0.left, pr0.left, pr0.right, (note.halfW + 8) * at0.scale, scroller.scrollLeft, scroller.scrollWidth - scroller.clientWidth);
		const scrollTops: number[] = [], scrollLefts: number[] = [];
		for (let i = 1; i <= 6; i++) {
			const dir = i <= 3 ? 1 : -1;
			scroller.scrollTop += dir * vy.sign * vy.step / at0.scale;
			if (hScrollable) scroller.scrollLeft += dir * vx.sign * vx.step / at0.scale;
			await frame();
			scrollTops.push(scroller.scrollTop); scrollLefts.push(scroller.scrollLeft);
			await shoot("scroll", `scroll ${i} top=${Math.round(scroller.scrollTop)} left=${Math.round(scroller.scrollLeft)}`);
		}
		const scrollEnd = { left: scroller.scrollLeft, top: scroller.scrollTop };
		const scrollTravel = {
			topPainted: (Math.max(...scrollTops, scrollStart.top) - Math.min(...scrollTops, scrollStart.top)) * at0.scale,
			leftPainted: (Math.max(...scrollLefts, scrollStart.left) - Math.min(...scrollLefts, scrollStart.left)) * at0.scale,
		};
		await quiet();
		await shoot("scroll-settle", "scroll settle");
		const zin = await gesture("in", [1.5, 2, 3, 4.5, 6, 7.5, 9, 10]);
		// POSITIVE CONTROL: a known 20 layer px shift must read back as 20 x scale.
		const layer = overlay.inkLayer as HTMLElement, t = layer.style.transform;
		layer.style.transform = `${t} translate(20px,0px)`.trim();
		await frame();
		await shoot("control", "control +20 layer px");
		layer.style.transform = t;
		await settle(4);
		const zin2 = await gesture("in2", [1.1, 1.25, 1.4, 1.6, 1.8, 2]);
		return {
			readable, infiniteCanvas, settings, note, strokes: strokes.length, frames, calls, applyStack, pinchStack, writeStack,
			gestures: { out, in: zin, in2: zin2 }, scroll: { hScrollable, scrollStart, scrollEnd, scrollTravel },
		};
	} finally {
		for (const u of unwrap) u();
		delete (overlay as any).handleResize; delete (overlay as any).repaint; delete (overlay as any).armDeferredRepaint;
		view.destroy();
		pane.remove();
	}
}

/**
 * Locate the magenta block in a decoded screenshot: a colour mask (worst
 * channel within 64 of #ff00ff), a 5x5 majority (the binary median, 13 of 25),
 * then 8-connected components; the largest is the mark and the runners-up are
 * reported so a merged or stray blob is visible. Runs on a screenshot, never on
 * a canvas the overlay owns.
 *
 * THE TEXT'S COMPOSITED LEFT EDGE, from the same image: in the image rows
 * the mark's own rows widened by `textPad` image px, the leftmost image column left of the mark holding at
 * least 2 dark grey pixels (max channel < 160, chroma < 40). A second oracle for
 * "where the text is on screen" that does not come from layout.
 */
/** Magenta pixels of a whole-viewport shot that lie outside `rect` (CSS px; the shot is at scale 2). */
async function countMagentaOutside(b64: string, rect: { x: number; y: number; width: number; height: number }) {
	const img = new Image();
	img.src = `data:image/png;base64,${b64}`;
	await img.decode();
	const w = img.naturalWidth, h = img.naturalHeight;
	const c = document.createElement("canvas");
	c.width = w; c.height = h;
	const g = c.getContext("2d", { willReadFrequently: true })!;
	g.drawImage(img, 0, 0);
	const d = g.getImageData(0, 0, w, h).data;
	const s = w / window.innerWidth;
	const x0 = rect.x * s, x1 = (rect.x + rect.width) * s, y0 = rect.y * s, y1 = (rect.y + rect.height) * s;
	let outside = 0, inside = 0;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const i = (y * w + x) * 4;
		if (!(d[i]! > 191 && d[i + 1]! < 64 && d[i + 2]! > 191)) continue;
		if (x >= x0 && x < x1 && y >= y0 && y < y1) inside++; else outside++;
	}
	return { outside, inside, w, h };
}
async function detectMark(b64: string, shift = 0, textPad?: number) {
	const img = new Image();
	img.src = `data:image/png;base64,${b64}`;
	await img.decode();
	const w = img.naturalWidth, h = img.naturalHeight;
	const c = document.createElement("canvas");
	c.width = w; c.height = h;
	const g = c.getContext("2d", { willReadFrequently: true })!;
	// `shift` is the detector's own positive control: the same pixels drawn
	// `shift` px to the right must read back `shift` px to the right.
	g.fillStyle = "#ffffff"; g.fillRect(0, 0, w, h);
	g.drawImage(img, shift, 0);
	const d = g.getImageData(0, 0, w, h).data;
	const W = w + 1, sat = new Int32Array(W * (h + 1));
	for (let y = 0; y < h; y++) {
		let row = 0;
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			row += Math.max(255 - d[i]!, d[i + 1]!, 255 - d[i + 2]!) <= 64 ? 1 : 0;
			sat[(y + 1) * W + x + 1] = sat[y * W + x + 1]! + row;
		}
	}
	const keep = new Uint8Array(w * h);
	for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
		const s = sat[(y + 3) * W + x + 3]! - sat[(y - 2) * W + x + 3]! - sat[(y + 3) * W + x - 2]! + sat[(y - 2) * W + x - 2]!;
		if (s >= 13) keep[y * w + x] = 1;
	}
	const comps: { n: number; minX: number; maxX: number; minY: number; maxY: number }[] = [];
	const stack = new Int32Array(w * h);
	for (let start = 0; start < w * h; start++) {
		if (!keep[start]) continue;
		keep[start] = 0;
		let sp = 0; stack[sp++] = start;
		const cp = { n: 0, minX: Infinity, maxX: -1, minY: Infinity, maxY: -1 };
		while (sp) {
			const p = stack[--sp]!, x = p % w, y = (p - x) / w;
			cp.n++; if (x < cp.minX) cp.minX = x; if (x > cp.maxX) cp.maxX = x; if (y < cp.minY) cp.minY = y; if (y > cp.maxY) cp.maxY = y;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
				const q = ny * w + nx;
				if (keep[q]) { keep[q] = 0; stack[sp++] = q; }
			}
		}
		comps.push(cp);
	}
	comps.sort((a, b) => b.n - a.n);
	const m = comps[0];
	let textLeft: number | null = null;
	if (textPad !== undefined && m) {
		const y0 = Math.max(0, m.minY - textPad), y1 = Math.min(h, m.maxY + 1 + textPad);
		const xEnd = m ? Math.max(0, m.minX - 4) : w;
		for (let x = 0; x < xEnd && textLeft === null; x++) {
			let dark = 0;
			for (let y = y0; y < y1; y++) {
				const i = (y * w + x) * 4, mx = Math.max(d[i]!, d[i + 1]!, d[i + 2]!), mn = Math.min(d[i]!, d[i + 1]!, d[i + 2]!);
				if (mx < 160 && mx - mn < 40 && ++dark >= 2) { textLeft = x; break; }
			}
		}
	}
	return {
		w, h, n: m ? m.n : 0, minX: m ? m.minX : null, maxX: m ? m.maxX : null, minY: m ? m.minY : null, maxY: m ? m.maxY : null,
		components: comps.length, others: comps.slice(1, 4), textLeft,
	};
}

/**
 * CONTINUOUS PINCH, NO CAPTURE HOLDS. The pixel arm holds each gesture step
 * still while it captures; a finger does not. This drives the same zoom through
 * the router at one step per animation frame and records, at every flushPinch,
 * the preview offset and both transforms. No screenshots: on the pixel arm the
 * offset field matched the composited displacement within 0.6 device px.
 *
 * Sweeps, in one mount, each 30 geometric steps: zoom out with the focal point
 * still, then back in; zoom out with the focal point moving right 3 px a step,
 * then back in; zoom out with it moving left 3 px a step, then back in.
 */
async function runContinuousOffsetTrace(readable: boolean, infiniteCanvas: boolean) {
	const rig = await mount(`trace-${readable ? "rll" : "full"}-${infiniteCanvas ? "ic" : "noic"}`, readable, infiniteCanvas);
	const { view, overlay, pane, sizer, path } = rig;
	const scroller = view.scrollDOM;
	const proto = InkOverlayPluginProto() as any;
	const rows: any[] = [];
	let sweep = "";
	const parseX = (t: string): number => { const m = /translate\(([-0-9.e+]+)px/.exec(t); return m ? Number(m[1]) : 0; };
	const origFlush = proto.flushPinch;
	proto.flushPinch = function (this: any, ...a: unknown[]) {
		const out = origFlush.apply(this, a);
		if (this === overlay && sweep) {
			const cam = overlay.lastPaintCam;
			const layerT = (overlay.inkLayer as HTMLElement | null)?.style.transform ?? "", sizerT = sizer.style.transform;
			rows.push({
				sweep, settle: a[0] === true, k: overlay.pinchScaleNow, css: overlay.cssScale, preview: !!overlay.pinchPreview, offset: overlay.previewInkOffset,
				layerT, sizerT, layerMinusSizerX: parseX(layerT) - parseX(sizerT),
				panX: overlay.viewportPan && Number.isFinite(overlay.viewportPan.x) ? overlay.viewportPan.x : 0,
				cam: cam ? `${cam.x.toFixed(2)},${cam.y.toFixed(2)}` : "null", sl: scroller.scrollLeft, st: scroller.scrollTop,
				at: Math.round(performance.now()),
			});
		}
		return out;
	};
	const quiet = async () => { await settle(8); await new Promise(r3 => setTimeout(r3, 300)); await settle(6); };
	setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
	const paneRect = pane.getBoundingClientRect();
	// The same mark, in the same place, as the pixel arm.
	scroller.scrollTop = 1800;
	scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
	await quiet();
	const col = contentOriginLeft(view.contentDOM) ?? paneRect.left;
	let stamp = 0;
	const pen = (type: string, x: number, y: number, id: number, buttons: number) => {
		const target = document.elementFromPoint(x, y);
		if (!target || !scroller.contains(target)) throw new Error(`trace pen misses scroller: ${x},${y}`);
		const e = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: id, isPrimary: true, clientX: x, clientY: y, buttons, pressure: buttons ? 0.5 : 0 });
		stamp = Math.max(e.timeStamp, stamp + 1);
		Object.defineProperty(e, "timeStamp", { value: stamp });
		target.dispatchEvent(e);
	};
	const markX0 = Math.round(col + 422), markY0 = Math.round(paneRect.top + 300);
	for (let i = 0; i < 20; i++) {
		const x = markX0 + i * 3;
		pen("pointerdown", x, markY0, 800 + i, 1);
		for (let y = markY0 + 20; y <= markY0 + 240; y += 20) pen("pointermove", x, y, 800 + i, 1);
		pen("pointerup", x, markY0 + 240, 800 + i, 0);
	}
	await settle(10);
	setInkSizeMult("pen", 1);
	const strokes = inlineInk.strokes(path);
	const xs = strokes.flatMap((s: any) => s.points.map((p: any) => p.x)), ys = strokes.flatMap((s: any) => s.points.map((p: any) => p.y));
	const note = { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2 };
	const markAt = () => {
		const c = view.contentDOM, cr = c.getBoundingClientRect();
		const scale = c.offsetWidth > 0 ? cr.width / c.offsetWidth : NaN;
		const colX = contentOriginLeft(c);
		const padTop = parseFloat(getComputedStyle(c).paddingTop) || 0;
		return { scale, x: colX === null ? null : colX + note.cx * scale, y: cr.top + padTop * scale + note.cy * scale };
	};
	const centre = async () => {
		const m = markAt(), pr = pane.getBoundingClientRect();
		if (m.x === null || !(m.scale > 0)) return;
		const dx = m.x - (pr.left + pr.width / 2), dy = m.y - (pr.top + pr.height / 2);
		if (Math.abs(dy) > 40) scroller.scrollTop += dy / m.scale;
		if (Math.abs(dx) > 40 && scroller.scrollWidth > scroller.clientWidth) scroller.scrollLeft += dx / m.scale;
		await quiet();
	};
	const router = overlay.router;
	const touchEvent = (type: string) => new PointerEvent(type, { pointerId: 953, pointerType: "touch" });
	const STEPS = 30;
	const drive = async (name: string, from: number, to: number, drift: number) => {
		const m = markAt(), pr = pane.getBoundingClientRect();
		const c = { x: Math.min(pr.right - 150, Math.max(pr.left + 150, m.x ?? pr.left + pr.width / 2)), y: Math.min(pr.bottom - 60, Math.max(pr.top + 60, m.y)) };
		const set = (x: number, ratio: number) => { router.touchPos.set(952, { x: x - 150 * ratio, y: c.y }); router.touchPos.set(953, { x: x + 150 * ratio, y: c.y }); };
		const kStart = overlay.pinchScaleNow, slStart = scroller.scrollLeft;
		sweep = name;
		set(c.x, 1); router.beginPinch(touchEvent("pointerdown"));
		let x = c.x;
		for (let i = 1; i <= STEPS; i++) {
			x += drift;
			set(x, Math.pow(to / from, i / STEPS)); router.updatePinch(touchEvent("pointermove"));
			await frame();
		}
		router.endPinch(touchEvent("pointerup"), { x, y: c.y }); router.touchPos.clear();
		await settle(12);
		sweep = "";
		await quiet();
		return { sweep: name, focal: c, endFocalX: x, kStart, kEnd: overlay.pinchScaleNow, slStart };
	};
	try {
		const gestures: any[] = [];
		await centre();
		gestures.push(await drive("out-still", 1, 0.1, 0));
		gestures.push(await drive("in-after-still", 0.1, 1, 0));
		await centre();
		gestures.push(await drive("out-focal-right", 1, 0.1, 3));
		gestures.push(await drive("in-after-right", 0.1, 1, 0));
		await centre();
		gestures.push(await drive("out-focal-left", 1, 0.1, -3));
		gestures.push(await drive("in-after-left", 0.1, 1, 0));
		const dpr = window.devicePixelRatio;
		const summary = [...new Set(rows.map(r => r.sweep))].map(name => {
			const rs = rows.filter(r => r.sweep === name), pv = rs.filter(r => r.preview && !r.settle);
			const off = pv.filter(r => Math.abs(r.offset) > 0.5);
			const pan = pv.map(r => r.panX);
			let up = 0, down = 0;
			for (let i = 1; i < pan.length; i++) { if (pan[i]! > pan[i - 1]! + 0.01) up++; else if (pan[i]! < pan[i - 1]! - 0.01) down++; }
			let camJumpsWithPan = 0;
			for (let i = 1; i < pv.length; i++) if (pv[i].cam !== pv[i - 1].cam && pv[i].layerT !== "") camJumpsWithPan++;
			return {
				sweep: name, flushes: rs.length, previewFlushes: pv.length, offsetFrames: off.length,
				maxAbsOffsetLayer: off.length ? Math.max(...off.map(r => Math.abs(r.offset))) : 0,
				maxAbsOffsetDevice: off.length ? Math.max(...off.map(r => Math.abs(r.offset) * r.css * dpr)) : 0,
				signedOffsets: off.map(r => Math.round(r.offset * 100) / 100), offsetKs: off.map(r => Math.round(r.k * 1000) / 1000),
				maxAbsLayerMinusSizerX: pv.length ? Math.max(...pv.map(r => Math.abs(r.layerMinusSizerX))) : 0,
				panFirst: pan[0] ?? null, panLast: pan[pan.length - 1] ?? null, panUpSteps: up, panDownSteps: down,
				camJumpsWithPan, kFirst: pv[0]?.k ?? null, kLast: pv[pv.length - 1]?.k ?? null,
				msSpan: pv.length ? pv[pv.length - 1].at - pv[0].at : 0,
			};
		});
		return { readable, infiniteCanvas, dpr, gestures, summary, rows };
	} finally {
		proto.flushPinch = origFlush;
		view.destroy();
		pane.remove();
	}
}


// ---- OWNED PANE SCROLL: the visible pane vs the transformed editor at 10% far right + bottom ----
// Real pen input arrives from the test through CDP at page coordinates, so the
// browser's own hit-testing picks the target; nothing here dispatches onto a
// chosen root. The page only mounts, navigates and reads.
let paneScrollRig: Awaited<ReturnType<typeof mount>> | null = null;
function paneScrollRect(el: Element | null | undefined) {
	if (!el) return null;
	const q = el.getBoundingClientRect();
	const r3 = (n: number) => Math.round(n * 1000) / 1000;
	return { l: r3(q.left), t: r3(q.top), r: r3(q.right), b: r3(q.bottom), w: r3(q.width), h: r3(q.height) };
}
function paneScrollDescribe(el: Element | null): string[] {
	const chain: string[] = [];
	let e: Element | null = el;
	for (let i = 0; i < 4 && e; i++) {
		const cls = typeof e.className === "string" ? e.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
		chain.push(e.tagName.toLowerCase() + (cls ? "." + cls : ""));
		e = e.parentElement;
	}
	return chain;
}
/** Committed ink within +-radius css px of a client point; inside=false when the point is outside the canvas box. */
function paneScrollInkNear(canvas: HTMLCanvasElement, x: number, y: number, radius = 6): { inside: boolean; pixels: number } {
	const r = canvas.getBoundingClientRect();
	if (x < r.left || x > r.right || y < r.top || y > r.bottom || r.width === 0) return { inside: false, pixels: 0 };
	const sx = canvas.width / r.width, sy = canvas.height / r.height;
	const x0 = Math.max(0, Math.floor((x - r.left - radius) * sx)), y0 = Math.max(0, Math.floor((y - r.top - radius) * sy));
	const w = Math.min(canvas.width - x0, Math.ceil(2 * radius * sx)), h = Math.min(canvas.height - y0, Math.ceil(2 * radius * sy));
	if (w <= 0 || h <= 0) return { inside: true, pixels: 0 };
	const d = canvas.getContext("2d")!.getImageData(x0, y0, w, h).data;
	let n = 0;
	for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
	return { inside: true, pixels: n };
}
/** Mount at `pinch` (through the pinch gesture), Infinite Canvas and Readable line length on, then scroll far on both axes. */
async function runPaneScrollMount(pinch: number, farVisual: number, hostShell: boolean) {
	const rig = await mount("pane-scroll", true, true, undefined, hostShell);
	paneScrollRig = rig;
	const { view, overlay, pane } = rig;
	const scroller = view.scrollDOM;
	// The fixture's stand-in pane carries an INLINE `overflow: hidden`, which
	// outranks every stylesheet rule. The app's pane has no inline overflow:
	// the plugin's class rule governs it, and that rule is the thing under
	// test here, so the fixture's inline value comes off.
	pane.style.removeProperty("overflow");
	setDiagnosticsEnabled(true);
	await settle(6);
	const r = pane.getBoundingClientRect();
	const focal = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	overlay.pinch("start", 1, focal);
	overlay.pinch("move", Math.sqrt(pinch), focal);
	await settle(2);
	overlay.pinch("move", pinch, focal);
	await settle(2);
	overlay.pinch("end", pinch, focal);
	await settle(10);
	await new Promise(res => setTimeout(res, 250));
	await settle(4);
	surfaceExtents.grow(rig.path, { x: farVisual / pinch + 60000, y: farVisual / pinch + 60000 });
	(overlay as any).updateExtent(true);
	await settle(10);
	scroller.scrollLeft = farVisual / pinch;
	scroller.scrollTop = farVisual / pinch;
	scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
	await settle(10);
	await new Promise(res => setTimeout(res, 300));
	await settle(6);
	return runPaneScrollRead([]);
}
/** Write a scroll offset onto the owned pane, as a foreign scroll-into-view walk or script would. Returns what the pane reads back. */
function runPaneScrollWrite(left: number, top: number) {
	const pane = paneScrollRig!.pane;
	pane.scrollLeft = left; pane.scrollTop = top;
	return { left: pane.scrollLeft, top: pane.scrollTop };
}
/** Nudge the pane 1 px wider so the pane observer runs handleResize -> applyViewportBox (the self-heal path), then put it back. */
async function runPaneScrollNudge() {
	const pane = paneScrollRig!.pane;
	const w = pane.getBoundingClientRect().width;
	pane.style.width = `${w + 1}px`;
	await settle(6);
	pane.style.width = `${w}px`;
	await settle(6);
	await new Promise(res => setTimeout(res, 150));
	await settle(4);
	return runPaneScrollRead([]);
}
function runPaneScrollRead(points: { label: string; x: number; y: number }[]) {
	const rig = paneScrollRig!;
	const { view, overlay, pane } = rig;
	const scroller = view.scrollDOM, host = view.dom, o = overlay as any;
	const committed = o.committedCanvas as HTMLCanvasElement;
	const hits = points.map(p => {
		const el = document.elementFromPoint(p.x, p.y);
		return { label: p.label, x: p.x, y: p.y, target: paneScrollDescribe(el), inScroller: !!el && scroller.contains(el), ink: paneScrollInkNear(committed, p.x, p.y) };
	});
	const acq = summarizeAcquisitions(captureInlinePenTrace({} as never).events as never);
	return {
		supportsClip: typeof CSS !== "undefined" && CSS.supports("overflow", "clip"),
		// The host form production took (the overlay's own cached gate): css `zoom` shrinks the counter-sized host to the pane.
		hostZoom: typeof o.hostZoomSupported === "function" ? (o.hostZoomSupported() as boolean) : false,
		// The engine asked directly, so a gate that wrongly falls back where zoom exists goes red at the test's pin instead of passing.
		engineZoom: CSS.supports("zoom", "0.5"),
		paneOverflow: getComputedStyle(pane).overflowX,
		pinchScaleNow: o.pinchScaleNow, cssScale: o.cssScale,
		pane: { left: pane.scrollLeft, top: pane.scrollTop, sw: pane.scrollWidth, sh: pane.scrollHeight, cw: pane.clientWidth, ch: pane.clientHeight },
		scroller: { left: scroller.scrollLeft, top: scroller.scrollTop, cw: scroller.clientWidth, ch: scroller.clientHeight },
		rects: { pane: paneScrollRect(pane), host: paneScrollRect(host), scroller: paneScrollRect(scroller), container: paneScrollRect(o.container), committed: paneScrollRect(committed) },
		strokes: inlineInk.strokes(rig.path).length,
		acq, hits,
	};
}


// ---- INK TILES: every ink canvas under the counter-sized host, read layer-agnostically ----
/**
 * Mount at `pinch` through the pinch gesture on a pane of the given size (or the
 * default when `pane` is null), far on both axes when `farVisual` > 0. The page
 * only mounts and reads; the pen is driven from outside through the protocol.
 */
async function runTileMount(pinch: number, farVisual: number, pane: { w: number; h: number } | null, hostShell: boolean) {
	const rig = await mount("ink-tiles", true, true, undefined, hostShell, 400, pane ?? undefined);
	paneScrollRig = rig;
	const { view, overlay, pane: paneEl } = rig;
	const scroller = view.scrollDOM;
	paneEl.style.removeProperty("overflow");
	setDiagnosticsEnabled(true);
	await settle(6);
	if (pinch !== 1) {
		const r = paneEl.getBoundingClientRect();
		const focal = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
		overlay.pinch("start", 1, focal);
		overlay.pinch("move", Math.sqrt(pinch), focal);
		await settle(2);
		overlay.pinch("move", pinch, focal);
		await settle(2);
		overlay.pinch("end", pinch, focal);
		await settle(10);
		await new Promise(res => setTimeout(res, 250));
		await settle(4);
	}
	if (farVisual > 0) {
		surfaceExtents.grow(rig.path, { x: farVisual / pinch + 60000, y: farVisual / pinch + 60000 });
		(overlay as any).updateExtent(true);
		await settle(10);
		scroller.scrollLeft = farVisual / pinch;
		scroller.scrollTop = farVisual / pinch;
		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
		await settle(10);
		await new Promise(res => setTimeout(res, 300));
		await settle(6);
	}
	return runTileRead([]);
}
/** A fixed synthetic shape through the overlay's own draw path, for a raster that does not depend on pen timing. */
async function runTileDraw(x: number | null, y: number, id: number) {
	const rig = paneScrollRig!;
	drawAt(rig.view, x ?? contentOriginLeft(rig.view.contentDOM)! + 80, y, id);
	await settle(8);
	return runTileRead([]);
}
/** Scroll the editor's scroller by (dx, dy) layout px through a real scroll event, settle, report the resulting offsets. */
async function runTileScroll(dx: number, dy: number) {
	const rig = paneScrollRig!; const scroller = rig.view.scrollDOM;
	const bandBefore = (rig.overlay as any).band ? { ...(rig.overlay as any).band } : null;
	const before = { left: scroller.scrollLeft, top: scroller.scrollTop, band: bandBefore };
	scroller.scrollLeft += dx; scroller.scrollTop += dy;
	scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
	await settle(10); await new Promise(res => setTimeout(res, 250)); await settle(6);
	const o = rig.overlay as any;
	return { before, after: { left: scroller.scrollLeft, top: scroller.scrollTop }, reallocs: inkCanvasReallocs(), band: o.band ? { ...o.band } : null, layerRect: paneScrollRect(o.inkLayer) };
}
async function runTileTeardown() {
	const rig = paneScrollRig; if (!rig) return false;
	rig.view.destroy(); (rig.pane.closest(".workspace-leaf") ?? rig.pane).remove(); paneScrollRig = null; await settle(4); return true;
}
/** The scale factor a canvas's own transform applies, 1 when it has none. */
function tileOwnScale(transform: string): number {
	const m = /scale\(([-\d.e]+)/.exec(transform);
	return m ? parseFloat(m[1]!) : 1;
}
/**
 * Every canvas inside the ink layer, whatever field holds it: its css box, its
 * own transform, its backing, and the scaled extent = css box times its own
 * scale, which is the layout area the compositor has to stretch it over. A
 * fingerprint of the on-screen rect groups tiles across layers: tile i of every
 * layer covers the same rect, so the distinct rects ARE the tile grid and the
 * count per rect is the number of layers. Each canvas is tagged with its index
 * so the protocol side can match compositor layers to it by node id.
 */
function tileCanvases() {
	const o = paneScrollRig!.overlay as any;
	const layer = o.inkLayer as HTMLElement;
	const fields = ["highlightCanvas", "highlightWetCanvas", "committedCanvas", "wetCanvas", "tailCanvas", "wetTileCanvas"];
	const all = Array.from(layer.querySelectorAll("canvas")) as HTMLCanvasElement[];
	return all.map((c, index) => {
		c.setAttribute("data-hw-tile-probe", String(index));
		const cs = getComputedStyle(c), r = c.getBoundingClientRect();
		const cssW = parseFloat(c.style.width) || parseFloat(cs.width), cssH = parseFloat(c.style.height) || parseFloat(cs.height);
		const own = tileOwnScale(c.style.transform || "");
		return {
			index, field: fields.find(f => o[f] === c) ?? null,
			left: c.style.left, top: c.style.top, offset: { l: c.offsetLeft, t: c.offsetTop },
			css: { w: cssW, h: cssH }, transform: c.style.transform, origin: c.style.transformOrigin, computedTransform: cs.transform, opacity: cs.opacity,
			backing: { w: c.width, h: c.height }, ownScale: own,
			scaledExtent: { w: cssW * own, h: cssH * own },
			rect: { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height },
			rectKey: [r.left, r.top, r.width, r.height].map(v => v.toFixed(2)).join("/"),
		};
	});
}
/** Ink in every canvas whose rect covers the point, summed: the store's answer regardless of which tile or layer holds it. */
function tileBackingAt(canvases: HTMLCanvasElement[], x: number, y: number) {
	let pixels = 0; const tiles: number[] = [];
	canvases.forEach((c, i) => { const h = paneScrollInkNear(c, x, y); if (h.inside) { pixels += h.pixels; if (h.pixels > 0) tiles.push(i); } });
	return { pixels, tiles };
}
/** The inline tail's own backing, read apart from the four band layers: its bitmap, grid, tile and origin. */
function tailBackingInfo(o: any) {
	const c = o?.tailCanvas as HTMLCanvasElement | undefined, t = o?.tail as any, cfg = t?.inlineBacking;
	if (!c || !cfg) return null;
	return { w: c.width, h: c.height, grid: cfg.grid as number | null, tileW: cfg.tileW as number, tileH: cfg.tileH as number,
		backing: cfg.backing as number, fullW: Math.round(cfg.width * cfg.backing), fullH: Math.round(cfg.height * cfg.backing),
		originX: t.originX as number, originY: t.originY as number, mode: t.backingMode as string };
}
function runTileRead(points: { label: string; x: number; y: number }[], withBacking = true) {
	const rig = paneScrollRig!;
	const { view, overlay, pane } = rig;
	const scroller = view.scrollDOM, host = view.dom, o = overlay as any;
	const layer = o.inkLayer as HTMLElement;
	const canvases = tileCanvases();
	const els = Array.from(layer.querySelectorAll("canvas")) as HTMLCanvasElement[];
	const tiles = [...new Map(canvases.map(c => [c.rectKey, c.rect])).values()].sort((a, b) => a.t - b.t || a.l - b.l);
	const seamsX = [...new Set(tiles.map(t => Math.round(t.l * 100) / 100))].sort((a, b) => a - b).slice(1);
	const seamsY = [...new Set(tiles.map(t => Math.round(t.t * 100) / 100))].sort((a, b) => a - b).slice(1);
	const hits = points.map(p => {
		const el = document.elementFromPoint(p.x, p.y);
		return { label: p.label, x: p.x, y: p.y, target: paneScrollDescribe(el), inScroller: !!el && scroller.contains(el), backing: withBacking ? tileBackingAt(els, p.x, p.y) : { pixels: -1, tiles: [] as number[] } };
	});
	const acq = summarizeAcquisitions(captureInlinePenTrace({} as never).events as never);
	const gl = (() => { try { const c = document.createElement("canvas"); const g = (c.getContext("webgl2") || c.getContext("webgl")) as WebGLRenderingContext | null; if (!g) return null; const d = g.getExtension("WEBGL_debug_renderer_info"); return { maxTexture: g.getParameter(g.MAX_TEXTURE_SIZE) as number, renderer: String(d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)) }; } catch { return null; } })();
	return {
		pinchScaleNow: o.pinchScaleNow, cssScale: o.cssScale, dpr: window.devicePixelRatio, gl,
		rects: { pane: paneScrollRect(pane), host: paneScrollRect(host), scroller: paneScrollRect(scroller), container: paneScrollRect(o.container), layer: paneScrollRect(layer) },
		layerStyle: { w: layer.style.width, h: layer.style.height, transform: layer.style.transform, origin: layer.style.transformOrigin },
		containerCss: { w: parseFloat(getComputedStyle(o.container).width), h: parseFloat(getComputedStyle(o.container).height) },
		containerOffsetWidth: (o.container as HTMLElement | null)?.offsetWidth ?? null,
		// The pin (same fields, same names as ScrollExpansion.test.ts:52-53 /
		// scrollExpansionPage.ts:98): the harness engine's own CSS-zoom support,
		// and the overlay's host-form gate, read separately so a disagreement
		// between them is visible rather than assumed.
		engineZoom: CSS.supports("zoom", "0.5"), hostZoom: o.hostZoomSupported() as boolean,
		band: o.band ? { ...o.band } : null,
		canvases, tiles, layersPerTile: tiles.length ? canvases.length / tiles.length : 0, seams: { x: seamsX, y: seamsY },
		tailBacking: tailBackingInfo(o),
		reallocs: inkCanvasReallocs(),
		strokes: inlineInk.strokes(rig.path).length,
		acq, hits,
	};
}
/**
 * FNV-1a over every canvas backing, in DOM order: the raster identity a control
 * run is compared against. Kept OUT of runTileRead on purpose: a full-canvas
 * getImageData is a readback, and after a few of them Chromium takes the canvas
 * off the GPU, which removes the very compositor layer the texture-limit clip
 * lives on. The identity arms call this last, after everything else is read.
 */
function runTileHash() {
	const o = paneScrollRig!.overlay as any;
	const els = Array.from((o.inkLayer as HTMLElement).querySelectorAll("canvas")) as HTMLCanvasElement[];
	// A canvas with no backing (the highlight pair before any highlighter use) has nothing to read and getImageData
	// refuses a 0 width: it gets a marker in its own slot, so every other index still names the same canvas.
	return els.map(c => { if (c.width === 0 || c.height === 0) return "0x0"; const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data; let h = 2166136261; for (let i = 0; i < d.length; i++) { h ^= d[i]!; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); });
}

// ---- G3 TEAR: a text-layer anchor and an ink anchor at the same place, read per compositor frame from outside ----
/** The text anchor: a block widget in the document, a solid rule of a colour nothing else on the page has. */
class TearAnchorWidget extends WidgetType {
	constructor(readonly leftLayout: number, readonly topLayout: number) { super(); }
	toDOM() {
		const el = document.createElement("div");
		el.className = "hw-tear-text";
		el.style.cssText = `position:relative;left:${this.leftLayout}px;top:${this.topLayout}px;width:400px;height:120px;background:#ff00aa;margin:0;padding:0;border:0;pointer-events:none`;
		return el;
	}
	eq(o: TearAnchorWidget) { return o.leftLayout === this.leftLayout && o.topLayout === this.topLayout; }
	ignoreEvent() { return true; }
}
const tearAnchorEffect = StateEffect.define<{ line: number; leftLayout: number; topLayout: number } | null>();
const tearAnchorField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		deco = deco.map(tr.changes);
		for (const e of tr.effects) if (e.is(tearAnchorEffect)) {
			if (!e.value) return Decoration.none;
			const pos = tr.state.doc.line(e.value.line).from;
			return Decoration.set([Decoration.widget({ widget: new TearAnchorWidget(e.value.leftLayout, e.value.topLayout), block: true, side: -1 }).range(pos)]);
		}
		return deco;
	},
	provide: f => EditorView.decorations.from(f),
});
let tearRig: Awaited<ReturnType<typeof mount>> | null = null;
/**
 * Mount at `pinch` (through the pinch gesture when below 1), grow the extent, scroll to `scrollLayout` on both
 * axes, then place the text anchor at the given fraction of the pane's width and height (viewport css px), by
 * moving the widget in layout px until its rect lands there. Returns the rects the test draws the ink anchor along.
 */
async function runTearMount(pinch: number, scrollLayout: number, pane: { w: number; h: number } | null, hostShell: boolean, at: { fx: number; fy: number }) {
	const rig = await mount("tear", true, true, undefined, hostShell, 400, pane ?? undefined);
	tearRig = rig; paneScrollRig = rig;
	const { view, overlay, pane: paneEl } = rig;
	const scroller = view.scrollDOM;
	paneEl.style.removeProperty("overflow");
	setDiagnosticsEnabled(true);
	pickStripColor("Blue", "#0000ff");
	// A THICK nib: the screencast delivers one pixel per css px (measured on the ratio-2 pane: 1265-px frames for a
	// 1265 css viewport), so a default-width stroke at 10% is a 0.3 css px hairline that anti-aliases to near white and
	// no colour test can find it. The multiplier actually applied (clamped) is read back beside the rects.
	setInkSizeMult(getInlineTool(), 8);
	view.dispatch({ effects: StateEffect.appendConfig.of(tearAnchorField) });
	await settle(6);
	if (pinch !== 1) {
		const r = paneEl.getBoundingClientRect();
		const focal = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
		overlay.pinch("start", 1, focal); overlay.pinch("move", Math.sqrt(pinch), focal); await settle(2);
		overlay.pinch("move", pinch, focal); await settle(2); overlay.pinch("end", pinch, focal);
		await settle(10); await new Promise(res => setTimeout(res, 250)); await settle(4);
	}
	surfaceExtents.grow(rig.path, { x: scrollLayout + 80000, y: scrollLayout + 80000 });
	(overlay as any).updateExtent(true);
	await settle(10);
	scroller.scrollLeft = scrollLayout; scroller.scrollTop = scrollLayout;
	scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
	await settle(10); await new Promise(res => setTimeout(res, 300)); await settle(6);
	// The anchor: a block widget on a middle line, moved by relative offsets (layout px) until its rect sits at the
	// wanted point of the pane. At the far scroll the document itself is far above and left of the pane; the widget is
	// text-layer content all the same, and moves with the text.
	const k = (overlay as any).cssScale as number;
	const pr = paneEl.getBoundingClientRect();
	const wantX = pr.left + pr.width * at.fx, wantY = pr.top + pr.height * at.fy;
	// A line CodeMirror renders at the far scroll on every scale: past the document's end the viewport clamps to the
	// last lines, ~330 of them at 10% (8000 layout px of window) but ~75 at 100% (tear-base3: line 200 was not in the
	// DOM at 100%). The widget's own offsets then carry it to the wanted pane point.
	// The line whose box is nearest the scroll: at 100% CodeMirror renders only the lines around the visible window
	// (tear-base100: nothing at all at scrollTop 60090 past a 9600-px document), so the 100% cells scroll inside the
	// document and the anchor rides a line there; at 10% the window is 8000 layout px and the last lines are rendered.
	// A line CodeMirror is rendering right now (its viewport's first line, plus two), so the widget is in the DOM at
	// any scale and scroll; the computed-line forms failed at 100% twice (tear-base100, tear-base100b).
	const line = Math.max(1, Math.min(view.state.doc.lines, view.state.doc.lineAt(view.viewport.from).number + 2));
	view.dispatch({ effects: tearAnchorEffect.of({ line, leftLayout: 0, topLayout: 0 }) });
	await settle(4);
	let el = view.contentDOM.querySelector(".hw-tear-text") as HTMLElement | null;
	if (!el) throw new Error("tear anchor widget not in the DOM");
	const r0 = el.getBoundingClientRect();
	const leftLayout = Math.round((wantX - r0.left) / k), topLayout = Math.round((wantY - r0.top) / k);
	view.dispatch({ effects: tearAnchorEffect.of({ line, leftLayout, topLayout }) });
	await settle(6);
	el = view.contentDOM.querySelector(".hw-tear-text") as HTMLElement | null;
	if (!el) throw new Error("tear anchor widget lost after the move");
	return runTearRead();
}
function runTearRead() {
	const rig = tearRig!;
	const { view, overlay, pane } = rig;
	const o = overlay as any, scroller = view.scrollDOM;
	const el = view.contentDOM.querySelector(".hw-tear-text") as HTMLElement | null;
	return {
		cssScale: o.cssScale, dpr: window.devicePixelRatio, inkSizeMult: getInkSizeMult(getInlineTool()),
		rects: { pane: paneScrollRect(pane), host: paneScrollRect(view.dom), text: el ? paneScrollRect(el) : null, layer: paneScrollRect(o.inkLayer), container: paneScrollRect(o.container) },
		scroll: { left: scroller.scrollLeft, top: scroller.scrollTop }, band: o.band ? { ...o.band } : null,
		strokes: inlineInk.strokes(rig.path).length, reallocs: inkCanvasReallocs(),
		acq: summarizeAcquisitions(captureInlinePenTrace({} as never).events as never),
	};
}
/**
 * For the router hit-test parity cells: the
 * note-space point of the LAST stored stroke, so a test can drive a real pen
 * click at a known SCREEN point (cdpPen, outside this file) and read back
 * where the router actually placed it, independent of any internal
 * hit-test function - the oracle is the caller's own band/scroll/cssScale
 * arithmetic (from runTearRead), not a second call into the same code this
 * exists to check (runPixelColumn's file comment makes the same point about
 * not letting an overlay field be the oracle).
 */
function runTearLastStrokePoint() {
	const rig = tearRig!;
	const strokes = inlineInk.strokes(rig.path);
	const last = strokes[strokes.length - 1] as { points?: { x: number; y: number }[] } | undefined;
	const p = last?.points?.[0];
	return p ? { x: p.x, y: p.y } : null;
}
/**
 * For the backing-store cells: each ink canvas's backing
 * store size against its own on-screen rect * dpr, the same pairing the
 * source's reallocation-path record checks, read from outside so the
 * test does not depend on that assertion existing or firing. Mirrors
 * runLayerBoundsMount's canvas enumeration exactly (same five names).
 */
/**
 * A DETERMINISTIC version of the C2 read's own
 * finding (refreshViewportColumn, the style-observer's rAF callback, calling
 * commitCameraScale again while a pinch settle's hold is still pending
 * retires it - captured by stack trace in the C2SettleOrdering /
 * C2CentroidPanOrdering reads). Those reads left the timing to chance (mount
 * queues the style refresh once; whether it lands inside the narrow pending-
 * hold window is luck, measured 11/12 there). This forces it: drive a real
 * pinch to its end through the router (creates the hold, schedules its
 * held-consumer measure), then call the private `refreshViewportColumn`
 * directly in the SAME synchronous tick, before any frame has let the held
 * measure run. If the hold is retired, `outcome` reads "cancelled" here
 * without needing a single frame to pass. The re-commit is FORCED too: the
 * frozen column is perturbed by 1 px before the call, so the refresh measures
 * a change and commits whatever the rig's own takeover/refresh bases do (the
 * tear rig otherwise re-commits only through deferral C3, 400 vs 386 px).
 * Part 2 of C2 carries the hold through that same-scale
 * re-commit; with part 2 reverted the hold is cancelled.
 */
async function runTearForcedRefreshPlant(pinch: number, scrollLayout: number, pane: { w: number; h: number } | null, hostShell: boolean, at: { fx: number; fy: number }, cx: number, cy: number) {
	await runTearMount(pinch, scrollLayout, pane, hostShell, at);
	const rig = tearRig!;
	// Inlined, NOT `runTearPinch`: that helper's own `await settle(2)` after
	// `endPinch` lets 2 real frames pass before returning, which is enough
	// for an UNGATED held-consumer measure to already run and converge - the
	// first version of this plant found `hadHold=false` on every rep because
	// of exactly that (the hold had already resolved by the time it checked).
	// This calls `endPinch` and `refreshViewportColumn` in the SAME
	// synchronous tick, zero frames between them, so the hold is still
	// definitely pending when the forced call happens.
	const router = (rig.overlay as any).router;
	const setTouch = (spread: number) => { router.touchPos.set(861, { x: cx - spread / 2, y: cy }); router.touchPos.set(862, { x: cx + spread / 2, y: cy }); };
	const pinchEvent = (type: string) => new PointerEvent(type, { pointerId: 862, pointerType: "touch" });
	const target = pinch * 1.5, startSpread = 300, endSpread = startSpread * target / pinch;
	setTouch(startSpread); router.beginPinch(pinchEvent("pointerdown"));
	for (let i = 1; i <= 6; i++) { setTouch(startSpread + (endSpread - startSpread) * i / 6); router.updatePinch(pinchEvent("pointermove")); await frame(); }
	router.endPinch(pinchEvent("pointerup"), { x: cx, y: cy });
	router.touchPos.clear();
	const overlay = rig.overlay as any;
	// A REFERENCE to the hold object, not a spread copy: retirePanSettle
	// mutates this SAME object's `.outcome` in place then nulls
	// `overlay.panAnchorHold` (retirePanSettle in InkOverlay.ts) - a copy taken now
	// would freeze the "pending" outcome and never see the mutation; this
	// binding still sees it because objects are references in JS.
	const holdRef = overlay.panAnchorHold as { outcome: string; generation: number } | null;
	const outcomeBefore = holdRef?.outcome ?? null;
	const generationBefore = overlay.viewportGeneration;
	// The real return value, not just "the method exists": refreshViewportColumn
	// returns false (a no-op) if its OWN guard (frame.locked, no container, no
	// layout) refuses - that is a DIFFERENT finding from "it ran and the hold
	// survived", and this must not conflate the two.
	// FORCE the change the refresh compares against, so a re-commit happens on any rig.
	const layout = overlay.viewportLayout as { columnLocal: number | null };
	layout.columnLocal = (layout.columnLocal ?? 0) + 1;
	const ran: boolean = overlay.refreshViewportColumn();
	const outcomeAfter = holdRef?.outcome ?? null; // same object, read again
	const stillHeld = overlay.panAnchorHold === holdRef; // false means retired (nulled) or replaced
	const generationAfter = overlay.viewportGeneration;
	const after = runTearRead();
	forcedHold = holdRef;
	return { ran, hadHold: holdRef !== null, outcomeBefore, outcomeAfter, stillHeld, generationChanged: generationBefore !== generationAfter, after };
}
/** The forced plant's hold, read again after frames: a carried hold must still converge, not sit pending. */
let forcedHold: { outcome: string } | null = null;
async function runTearForcedRefreshSettled() {
	await settle(30);
	const overlay = tearRig!.overlay as any;
	return { outcome: forcedHold?.outcome ?? null, holdRemaining: !!overlay.panAnchorHold };
}

function runTearBacking() {
	const rig = tearRig!;
	const o = rig.overlay as any;
	const names = ["committedCanvas", "highlightCanvas", "wetCanvas", "highlightWetCanvas", "tailCanvas"] as const;
	const dpr = window.devicePixelRatio;
	return names.map(n => {
		const c = o[n] as HTMLCanvasElement;
		const r = c.getBoundingClientRect();
		return { name: n, backing: { w: c.width, h: c.height }, rect: { w: r.width, h: r.height }, expectedBacking: { w: Math.round(r.width * dpr), h: Math.round(r.height * dpr) }, transform: getComputedStyle(c).transform,
			released: n === "wetCanvas" && o.wetDeferred === true };
	});
}
/**
 * Step 7: SEED THE NOTE BY EXTENT, so the rig's committed-ink repaint has
 * something to cost.
 *
 * The device trace named the site: one 3536.8 ms task at pinch-end, of which
 * 3332.0 ms is canvas `closePath` self time, reached through
 * `handleResize` -> `repaint` -> `paintCommittedWork` -> `fillRibbon`. Every
 * rig arm so far read flat because the rig's notes carry `strokes: 0` - there
 * was no committed ink to repaint, so the site could not be entered.
 *
 * WHY LONG STROKES AND NOT MANY SHORT ONES. `drawCommitted` culls per stroke by
 * BBOX ONLY (StrokeRenderer.ts:376-384) and never clips within a stroke, and
 * `fillRibbon` emits `moveTo` + 3x `lineTo` + `closePath` per SEGMENT, one
 * segment per sample (RibbonRenderer.ts:113-160), plus an `arc` per joint. So a
 * stroke whose bbox the camera intersects pays its whole sample count even when
 * only a hand's width of it is on screen. Seeding by extent - a few strokes,
 * each a long sample-dense drag far right and far down - is therefore the shape
 * that puts hundreds of thousands of path calls into one repaint, which is what
 * the device's numbers describe. Many short strokes at the same total sample
 * count would be culled away instead.
 *
 * The strokes are clones of one REAL pen stroke, so every field but `points`,
 * `bbox` and `id` is whatever the product itself produced.
 */
async function runTearSeedExtentInk(count: number, samples: number, span: number, anchor: "origin" | "camera" = "origin") {
	const rig = tearRig!;
	const { view, path } = rig;
	const scroller = view.scrollDOM;
	// THE TEMPLATE IS DRAWN AT THE TOP OF THE DOCUMENT, then the scroll is put
	// back. A pen dispatched at a far scroll lands outside the rendered content
	// and draws nothing - the offset arms failed exactly that way ("seed needs
	// one real stroke as a template; none was drawn") before this.
	const keep = { left: scroller.scrollLeft, top: scroller.scrollTop };
	if (keep.left !== 0 || keep.top !== 0) {
		scroller.scrollLeft = 0; scroller.scrollTop = 0;
		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
		await settle(8);
	}
	const pr = rig.pane.getBoundingClientRect();
	drawAt(view, (contentOriginLeft(view.contentDOM) ?? pr.left) + 80, pr.top + 200, 193);
	await settle(4);
	const template = inlineInk.strokes(path)[0];
	if (!template) throw new Error("seed needs one real stroke as a template; none was drawn");
	if (keep.left !== 0 || keep.top !== 0) {
		scroller.scrollLeft = keep.left; scroller.scrollTop = keep.top;
		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
		await settle(8);
	}
	// WHERE THE BLOCK GOES. "origin" puts it on the template stroke, which is
	// near note-space zero. "camera" puts it at the camera's own top-left, which
	// at a far scroll is note-space coordinates in the tens of thousands - the
	// same geometry, much larger numbers, and still inside the bbox cull. Placing
	// a far block at a fixed note offset instead does NOT work: note space and
	// scroll px are not the same units, so the ink landed outside the camera and
	// the arm measured an empty repaint.
	const origin = template.points[0]!;
	const cam = (rig.overlay as any).camera;
	const base = anchor === "camera" ? { x: cam.x + 40, y: cam.y + 40 } : { x: origin.x, y: origin.y };
	let totalPoints = 0;
	for (let s = 0; s < count; s++) {
		// Each stroke starts a little further along the diagonal and runs the
		// whole span right and down, so the bboxes overlap the way a page of
		// handwriting does rather than tiling into disjoint boxes.
		// `offset` moves the whole seeded block away from the origin without
		// changing its size, which is what separates "the numbers are big" from
		// "the stroke is long" - see the cost-shape cell.
		const x0 = base.x + s * 40;
		const y0 = base.y + s * 40;
		const points = [];
		for (let i = 0; i < samples; i++) {
			const u = i / (samples - 1);
			points.push({
				...origin,
				x: x0 + span * u,
				// A wave, not a straight run: a straight line has no joints, and
				// the joint discs are a per-sample `arc` that real ink pays.
				y: y0 + span * u + Math.sin(u * Math.PI * 40) * 120,
			});
		}
		totalPoints += points.length;
		const xs = points.map(q => q.x), ys = points.map(q => q.y);
		const bx = Math.min(...xs), by = Math.min(...ys);
		inlineInk.commit(path, {
			...template,
			id: `${template.id}-ext${s}`,
			points: points as typeof template.points,
			bbox: { x: bx, y: by, width: Math.max(...xs) - bx, height: Math.max(...ys) - by },
		});
	}
	surfaceExtents.grow(path, { x: base.x + span + 2000, y: base.y + span + 2000 });
	(rig.overlay as any).updateExtent(true);
	const stored = inlineInk.strokes(path);
	return {
		stored: stored.length,
		totalPoints,
		span,
		anchor,
		base,
		camera: { x: cam.x, y: cam.y, zoom: cam.zoom },
		bbox: stored.reduce((acc, st) => ({
			x: Math.min(acc.x, st.bbox.x), y: Math.min(acc.y, st.bbox.y),
			right: Math.max(acc.right, st.bbox.x + st.bbox.width), bottom: Math.max(acc.bottom, st.bbox.y + st.bbox.height),
		}), { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity }),
	};
}

/**
 * Canvas 2D call counters, patched onto the prototype so every context the
 * overlay owns is counted. Rig-side only: nothing in `src/` knows about this.
 *
 * `closePath` is the call the device trace bills; the rest are here to settle
 * what the cost is MADE of. `drawImage`/`getImageData`/`clearRect` carry the
 * per-tile allocate-and-blit shape; the trace showed none of them in the
 * window's self time, and a rig read that agrees is a second, independent
 * measurement of the same claim.
 */
const canvasCounts: Record<string, number> = {};
let canvasCountersArmed = false;
function armCanvasCounters(): void {
	if (canvasCountersArmed) { for (const k of Object.keys(canvasCounts)) canvasCounts[k] = 0; return; }
	canvasCountersArmed = true;
	const proto = (window as any).CanvasRenderingContext2D.prototype;
	for (const name of ["beginPath", "moveTo", "lineTo", "closePath", "arc", "fill", "stroke", "clearRect", "drawImage", "getImageData", "putImageData", "setTransform"]) {
		canvasCounts[name] = 0;
		const original = proto[name];
		if (typeof original !== "function") continue;
		proto[name] = function (this: unknown, ...args: unknown[]) { canvasCounts[name]!++; return original.apply(this, args); };
	}
}
const readCanvasCounters = () => ({ ...canvasCounts });

/**
 * The committed layer's own backing, in device px, beside the css box it is
 * sized from. A pinch changes the css box (the pane does not move, but the
 * camera's world window does) and a reallocation blanks the canvas, so this is
 * the number that says whether a commit resized its raster or only repainted it.
 */
function readCommittedBacking() {
	const overlay = tearRig ? (tearRig.overlay as any) : null;
	if (!overlay) return null;
	const canvas = overlay.committedCtx?.canvas as HTMLCanvasElement | undefined;
	return {
		cssWidth: overlay.cssWidth, cssHeight: overlay.cssHeight, dpr: overlay.dpr,
		backing: canvas ? { width: canvas.width, height: canvas.height } : null,
		reallocs: inkCanvasReallocs(),
	};
}

/** Scroll the tear rig's scroller, for arms that seed ink away from the origin. */
async function runTearScrollTo(left: number, top: number) {
	const rig = tearRig!;
	const scroller = rig.view.scrollDOM;
	scroller.scrollLeft = left; scroller.scrollTop = top;
	scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
	await settle(10);
	return { left: scroller.scrollLeft, top: scroller.scrollTop, ...runTearRead() };
}

/**
 * The pinch of `runTearPinch`, with every `commitCameraScale` call bracketed by
 * the canvas counters and a wall clock, and with the strokes the camera's own
 * cull would keep counted at the same instant.
 *
 * WHY PER COMMIT. The device's cost is one task at pinch-end, not a slow drip
 * across the gesture, and `handleResize`'s synchronous branch
 * (InkOverlay.ts:3518) sits inside `commitCameraScale`. Bracketing the commit
 * is what separates "the whole gesture was slow" from "one commit painted every
 * stroke in the note".
 *
 * `intersecting` is computed with the same bbox test `drawCommitted` uses, so
 * it can be compared against the measured `beginPath` delta: `fillRibbon` opens
 * exactly one path per stroke it paints, so the two agreeing is a check that
 * the counters and the cull are talking about the same strokes, and the two
 * diverging says something else is drawing.
 */
async function runTearPinchCounted(from: number, to: number, steps: number, cx: number, cy: number) {
	const rig = tearRig!;
	const overlay = rig.overlay as any;
	const router = overlay.router;
	const path = rig.path;
	armCanvasCounters();
	type Row = { depth: number; ms: number; intersecting: number; delta: Record<string, number>; backing: ReturnType<typeof readCommittedBacking> };
	const rows: Row[] = [];
	let depth = 0;
	const commit = overlay.commitCameraScale;
	const cull = () => {
		const cam = overlay.camera ?? { x: 0, y: 0, zoom: overlay.cssScale ?? 1 };
		const w = overlay.cssWidth ?? 0, h = overlay.cssHeight ?? 0;
		const right = cam.x + w / (cam.zoom || 1), bottom = cam.y + h / (cam.zoom || 1);
		return inlineInk.strokes(path).filter(s => !(s.bbox.x > right || s.bbox.y > bottom || s.bbox.x + s.bbox.width < cam.x || s.bbox.y + s.bbox.height < cam.y)).length;
	};
	overlay.commitCameraScale = function (this: unknown, ...args: unknown[]) {
		const before = readCanvasCounters();
		const t = performance.now();
		const atDepth = depth;
		depth++;
		try { return commit.apply(this, args); }
		finally {
			depth--;
			const after = readCanvasCounters();
			const delta: Record<string, number> = {};
			for (const k of Object.keys(after)) delta[k] = after[k]! - before[k]!;
			rows.push({ depth: atDepth, ms: Math.round((performance.now() - t) * 10) / 10, intersecting: cull(), delta, backing: readCommittedBacking() });
		}
	};
	try {
		const setTouch = (spread: number) => { router.touchPos.set(861, { x: cx - spread / 2, y: cy }); router.touchPos.set(862, { x: cx + spread / 2, y: cy }); };
		const pinchEvent = (type: string) => new PointerEvent(type, { pointerId: 862, pointerType: "touch" });
		const startSpread = 300, endSpread = startSpread * to / from;
		const backingBefore = readCommittedBacking();
		const began = performance.now();
		setTouch(startSpread); router.beginPinch(pinchEvent("pointerdown"));
		// PER MOVE FRAME, not only per commit. The first run of the heavy arm put
		// 617.6 ms in the commit and 2786 ms in the whole gesture, and the whole
		// gesture's closePath total was 446 021 against the commit's 118 007 - so
		// most of the painting happened somewhere other than the commit and no
		// counter was watching it. These rows are that counter.
		const moves: { i: number; ms: number; delta: Record<string, number> }[] = [];
		for (let i = 1; i <= steps; i++) {
			const before = readCanvasCounters();
			const t = performance.now();
			setTouch(startSpread + (endSpread - startSpread) * i / steps);
			router.updatePinch(pinchEvent("pointermove"));
			await frame();
			const after = readCanvasCounters();
			const delta: Record<string, number> = {};
			for (const k of Object.keys(after)) delta[k] = after[k]! - before[k]!;
			moves.push({ i, ms: Math.round((performance.now() - t) * 10) / 10, delta });
		}
		const endBegan = performance.now();
		const beforeEnd = readCanvasCounters();
		router.endPinch(pinchEvent("pointerup"), { x: cx, y: cy });
		const endMs = Math.round((performance.now() - endBegan) * 10) / 10;
		const afterEnd = readCanvasCounters();
		router.touchPos.clear();
		// THE SETTLE IS ITS OWN PHASE AND IT PAINTS. The heavy arm's whole gesture
		// counted 446 021 closePath against the commit's 118 007, and the move
		// frames counted none at all, so the remainder is here: repaints scheduled
		// after endPinch returns, outside any commitCameraScale. Bracketing it is
		// what stops the receipt attributing the whole cost to the commit.
		const settleBegan = performance.now();
		await settle(4);
		const afterSettle = readCanvasCounters();
		const phase = (a: Record<string, number>, b: Record<string, number>) => {
			const d: Record<string, number> = {};
			for (const k of Object.keys(b)) if (b[k]! - a[k]! !== 0) d[k] = b[k]! - a[k]!;
			return d;
		};
		const endPinchDelta = phase(beforeEnd, afterEnd);
		const settleDelta = phase(afterEnd, afterSettle);
		const settleMs = Math.round((performance.now() - settleBegan) * 10) / 10;
		return { gestureMs: Math.round((performance.now() - began) * 10) / 10, endPinchMs: endMs, endPinchDelta, settleMs, settleDelta, commits: rows, moves, totals: readCanvasCounters(), backingBefore, backingAfter: readCommittedBacking(), after: runTearRead() };
	} finally {
		overlay.commitCameraScale = commit;
	}
}

/** The router's two-finger pinch, `steps` moves one animation frame apart, from scale `from` to `to`, centred on (cx, cy). */
/**
 * The same gesture with COALESCED moves. `runTearPinch` awaits a frame
 * after every `updatePinch`, so it can never stack two moves inside one frame;
 * a touchscreen delivers several per frame. This fires `burst` moves back to
 * back with no await, THEN yields one frame, for `frames` frames.
 */
async function runTearPinchBurst(from: number, to: number, frames: number, burst: number, cx: number, cy: number) {
	const rig = tearRig!; const router = (rig.overlay as any).router;
	const setTouch = (spread: number) => { router.touchPos.set(861, { x: cx - spread / 2, y: cy }); router.touchPos.set(862, { x: cx + spread / 2, y: cy }); };
	const pinchEvent = (type: string) => new PointerEvent(type, { pointerId: 862, pointerType: "touch" });
	const startSpread = 300, endSpread = startSpread * to / from;
	const total = frames * burst;
	setTouch(startSpread); router.beginPinch(pinchEvent("pointerdown"));
	let sent = 0;
	for (let f = 1; f <= frames; f++) {
		for (let b = 0; b < burst; b++) {
			sent++;
			setTouch(startSpread + (endSpread - startSpread) * sent / total);
			router.updatePinch(pinchEvent("pointermove"));
		}
		await frame();
	}
	router.endPinch(pinchEvent("pointerup"), { x: cx, y: cy });
	router.touchPos.clear();
	await settle(2);
	return { sent, after: runTearRead() };
}

async function runTearPinch(from: number, to: number, steps: number, cx: number, cy: number) {
	const rig = tearRig!; const router = (rig.overlay as any).router;
	const setTouch = (spread: number) => { router.touchPos.set(861, { x: cx - spread / 2, y: cy }); router.touchPos.set(862, { x: cx + spread / 2, y: cy }); };
	const pinchEvent = (type: string) => new PointerEvent(type, { pointerId: 862, pointerType: "touch" });
	const startSpread = 300, endSpread = startSpread * to / from;
	const scales: number[] = [];
	setTouch(startSpread); router.beginPinch(pinchEvent("pointerdown"));
	for (let i = 1; i <= steps; i++) {
		setTouch(startSpread + (endSpread - startSpread) * i / steps);
		router.updatePinch(pinchEvent("pointermove"));
		await frame();
		scales.push((rig.overlay as any).pinchScaleNow);
	}
	router.endPinch(pinchEvent("pointerup"), { x: cx, y: cy });
	router.touchPos.clear();
	await settle(2);
	return { scales, after: runTearRead() };
}
async function runTearTeardown() {
	const rig = tearRig; if (!rig) return false;
	rig.view.destroy(); (rig.pane.closest(".workspace-leaf") ?? rig.pane).remove(); tearRig = null; paneScrollRig = null; await settle(4); return true;
}

/**
 * A PANE RESIZE THE RESIZEOBSERVER HAS NOT DELIVERED, meeting a pinch settle (C2 part 2).
 * "before-release": the pane narrows in the same tick as endPinch, so the settle commit's own handleResize sees the new
 * width and nests a same-scale commit inside the settle commit. That nested commit must not carry the hold: the settle
 * commit is already its consumer, and a second one before convergence failed the settle.
 * "during-hold": the pane narrows after endPinch and handleResize runs in the same tick, outside any commit, while the
 * hold is pending: the part 2 case, where the same-scale re-commit carries the hold and the settle converges.
 * Every commitCameraScale call is recorded with its nesting depth and the scroll after it.
 */
async function runTearSettleResize(mode: "before-release" | "during-hold", panEngaged: boolean, cx: number, cy: number) {
	await runTearMount(0.1, 60090, null, true, { fx: 0.5, fy: 0.5 });
	const rig = tearRig!; const overlay = rig.overlay as any; const scroller = rig.view.scrollDOM; const router = overlay.router;
	type Call = { depth: number; settleHold: string; scrollAfter?: { left: number; top: number } };
	const calls: Call[] = []; let depth = 0;
	const commit = overlay.commitCameraScale;
	overlay.commitCameraScale = function (next: number, scroll?: unknown, settleHold?: unknown, ...rest: unknown[]) {
		const row: Call = { depth, settleHold: settleHold === undefined ? "undefined" : settleHold === null ? "null" : "hold" };
		calls.push(row); depth++;
		try { return commit.call(this, next, scroll, settleHold, ...rest); }
		finally { depth--; row.scrollAfter = { left: scroller.scrollLeft, top: scroller.scrollTop }; }
	};
	const setTouch = (spread: number, x: number) => { router.touchPos.set(861, { x: x - spread / 2, y: cy }); router.touchPos.set(862, { x: x + spread / 2, y: cy }); };
	const ev = (type: string) => new PointerEvent(type, { pointerId: 862, pointerType: "touch" });
	const startSpread = 300, endSpread = startSpread * 1.5;
	setTouch(startSpread, cx); router.beginPinch(ev("pointerdown"));
	let x = cx;
	for (let i = 1; i <= 6; i++) { if (panEngaged) x = cx + 12 * i; setTouch(startSpread + (endSpread - startSpread) * i / 6, x); router.updatePinch(ev("pointermove")); await frame(); }
	const pane = rig.pane; const paneW = pane.clientWidth;
	if (mode === "before-release") pane.style.width = `${paneW - 4}px`;
	router.endPinch(ev("pointerup"), { x, y: cy });
	router.touchPos.clear();
	const hold = overlay.panAnchorHold as { outcome: string } | null;
	const outcomeAtRelease = hold?.outcome ?? null;
	if (mode === "during-hold") { pane.style.width = `${paneW - 4}px`; overlay.handleResize(); }
	const settleCall = calls.find(c => c.settleHold === "hold");
	const landing = settleCall?.scrollAfter ?? null;
	await settle(30);
	return { mode, panEngaged, nested: calls.some(c => c.depth === 1 && c.settleHold === "undefined"), settleCommits: calls.filter(c => c.settleHold === "hold").length,
		outcomeAtRelease, outcome: hold?.outcome ?? null, holdRemaining: !!overlay.panAnchorHold, landing,
		final: { left: scroller.scrollLeft, top: scroller.scrollTop }, paneNarrowed: pane.clientWidth === paneW - 4 };
}

/**
 * A SAME-SCALE COMMIT INSIDE CODEMIRROR'S UPDATE while a pinch settle is pending (C2 part 2). The pane
 * narrows and the content font size changes in one task, and CodeMirror's synchronous measure runs its update before the
 * ResizeObserver can deliver: updateInner sees the font edge and calls handleResize inside the update, and the pane differs from
 * the layout, so handleResize commits same-scale there. A commit that carried the pending settle dispatched inside the update,
 * which CodeMirror refuses ("Calls to EditorView.update are not allowed while an update is in progress") by deactivating the
 * plugin: ink gone for that editor. Records every commit with whether it ran inside the update, and CodeMirror's crash log.
 */
async function runTearUpdateCarry(cx: number, cy: number) {
	await runTearMount(0.1, 60090, null, true, { fx: 0.5, fy: 0.5 });
	const rig = tearRig!; const overlay = rig.overlay as any; const view = rig.view; const router = overlay.router;
	const errors: string[] = [];
	const origError = console.error;
	console.error = (...a: unknown[]) => { errors.push(a.map(x => x instanceof Error ? x.message : String(x)).join(" ").slice(0, 400)); origError.apply(console, a as []); };
	const calls: { inUpdate: boolean; threw: string | null }[] = [];
	const commit = overlay.commitCameraScale;
	overlay.commitCameraScale = function (next: number, scroll?: unknown, settleHold?: unknown, ...rest: unknown[]) {
		const row = { inUpdate: !!this.inUpdate, threw: null as string | null };
		calls.push(row);
		try { return commit.call(this, next, scroll, settleHold, ...rest); } catch (e) { row.threw = String((e as Error)?.message ?? e); throw e; }
	};
	const setTouch = (spread: number) => { router.touchPos.set(861, { x: cx - spread / 2, y: cy }); router.touchPos.set(862, { x: cx + spread / 2, y: cy }); };
	const ev = (type: string) => new PointerEvent(type, { pointerId: 862, pointerType: "touch" });
	setTouch(300); router.beginPinch(ev("pointerdown"));
	for (let i = 1; i <= 6; i++) { setTouch(300 + 150 * i / 6); router.updatePinch(ev("pointermove")); await frame(); }
	router.endPinch(ev("pointerup"), { x: cx, y: cy });
	router.touchPos.clear();
	const hold = overlay.panAnchorHold as { outcome: string } | null;
	const outcomeAtRelease = hold?.outcome ?? null;
	const from = calls.length;
	const pane = rig.pane; const paneW = pane.clientWidth;
	const fontBefore = overlay.contentStyle?.fontSize ?? "";
	pane.style.width = `${paneW - 4}px`;
	const style = document.head.appendChild(document.createElement("style"));
	style.textContent = ".cm-content { font-size: 23px !important; }";
	(view as unknown as { measure(): void }).measure();
	const inUpdateCommits = calls.slice(from).filter(c => c.inUpdate).length;
	// Read while the rule is still in: the content style is live, and removing the rule puts the old size back.
	const fontChanged = (overlay.contentStyle?.fontSize ?? "") !== fontBefore;
	await settle(12);
	console.error = origError;
	style.remove();
	return { outcomeAtRelease, fontChanged, paneNarrowed: pane.clientWidth === paneW - 4, inUpdateCommits,
		threw: calls.slice(from).map(c => c.threw).filter(Boolean), crashed: errors.some(e => e.includes("CodeMirror plugin crashed")), holdRemaining: !!overlay.panAnchorHold,
		outcome: hold?.outcome ?? null };
}

(window as any).scrollColumnAnchor = { setScrollExpansionEnabled, runTearPinchBurst, runTearSeedExtentInk, runTearPinchCounted, runTearScrollTo, runPinchTeardown, countMagentaOutside, setShapeSnap, run, runFocal, runCentroidPan, runTopBoundary, runMarginPayment, runPinchReticle, runInfiniteTraversal, runExpandedDrawCoverage, runConstraintOrder, runColumnChanges, runColumnAutoControl, runColumnLocalGuardPlant, runViewportStyleObserver, runScrollDraw, runOwnedRequestCancellation, runZoomedWriteRoom, runLayerBoundsMount, runLayerBoundsTeardown, runPixelColumn, detectMark, runContinuousOffsetTrace , runPaneScrollMount, runPaneScrollWrite, runPaneScrollNudge, runPaneScrollRead , runTileMount, runTileRead, runTileDraw, runTileTeardown, runTileHash, runTileScroll , runTearMount, runTearRead, runTearPinch, runTearTeardown, runTearBacking, runTearLastStrokePoint, runTearForcedRefreshPlant, runTearForcedRefreshSettled, runTearSettleResize, runTearUpdateCarry };
/**
 * THE CAMERA'S SCALE OF RECORD, READ BESIDE AN INDEPENDENT MEASUREMENT.
 *
 * Three numbers make the camera's scale: the owned factor the last commit
 * requested (`pinchScaleNow`), the external factor captured when the viewport
 * was taken over (`viewportLayout.externalScale`), and the effective scale of
 * record (`cssScale`), which the allocation path overwrites with a measured
 * value (container rect / container offset) after every commit. Under a
 * zoom-shrunk host that measurement carries the layout engine's snap of the
 * ZOOMED box (1/64 css px), a relative error bounded by 1/(128 x rect width);
 * under a transform-scaled host the snap is taken in the unzoomed box and is
 * far smaller. The question a drift test asks is whether any of that error is
 * ever multiplied INTO the next request. This reader returns the three
 * numbers and its own measurement (the same inputs the overlay measures from,
 * read here so the oracle is not the code under test), and the driver below
 * issues the three zoom commands from outside so a test can run N commit
 * cycles and read the residuals after each.
 */
function runTearScaleRead() {
	const rig = tearRig!;
	const o = rig.overlay as any;
	const c = o.container as HTMLElement | null;
	const rect = c ? c.getBoundingClientRect() : null;
	const state = o.getNoteViewportState() as { zoom: number; busy: boolean; fitAvailable: boolean };
	return {
		pinchScaleNow: o.pinchScaleNow as number,
		cssScale: o.cssScale as number,
		externalScale: (o.viewportLayout ? o.viewportLayout.externalScale : null) as number | null,
		owned: !!o.viewportLayout,
		measured: rect && c && c.offsetWidth > 0 ? rect.width / c.offsetWidth : null,
		rectWidth: rect ? rect.width : null,
		offsetWidth: c ? c.offsetWidth : null,
		zoomFloor: o.zoomFloor as number,
		busy: state.busy,
		fitAvailable: state.fitAvailable,
		hostZoom: getComputedStyle(rig.view.dom).zoom,
		scroll: { left: rig.view.scrollDOM.scrollLeft, top: rig.view.scrollDOM.scrollTop },
	};
}
/** One zoom command from the outside - the zoom buttons' multiply, Fit, or reset - then a settle, then the reader above. */
async function runTearZoomOp(op: "by" | "fit" | "reset", factor: number) {
	const rig = tearRig!;
	const o = rig.overlay as any;
	const result: unknown = op === "by" ? o.zoomNoteBy(factor) : op === "fit" ? o.fitHandwriting() : o.resetNoteZoom();
	await settle(3);
	return { result, ...runTearScaleRead() };
}
Object.assign((window as any).scrollColumnAnchor, { runTearScaleRead, runTearZoomOp });
/**
 * The tool the next real pen-down draws with, and a thick nib for it (the same x8 runTearMount gives the pen), so a
 * highlighter stroke at 10% leaves pixels a reader can find.
 */
function runTearSetTool(tool: "pen" | "highlighter") {
	setInlineTool(tool); setInkSizeMult(tool, 8);
	return getInlineTool();
}
/**
 * Where the highlight pair sits in the whole-layer read (runTileHash), and the hash that read gives a canvas of the
 * pair's size holding nothing, so a test can tell a painted highlight layer from an empty one without trusting the
 * overlay's own bookkeeping.
 */
function runTearHighlightProbe() {
	const o = tearRig!.overlay as any;
	const els = Array.from((o.inkLayer as HTMLElement).querySelectorAll("canvas")) as HTMLCanvasElement[];
	const blank = (c: HTMLCanvasElement) => { if (c.width === 0 || c.height === 0) return "0x0"; let h = 2166136261; for (let i = 0; i < c.width * c.height * 4; i++) { h ^= 0; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
	return (["highlightCanvas", "highlightWetCanvas"] as const).map(n => { const c = o[n] as HTMLCanvasElement; return { name: n, index: els.indexOf(c), blankHash: blank(c) }; });
}
Object.assign((window as any).scrollColumnAnchor, { runTearSetTool, runTearHighlightProbe });
