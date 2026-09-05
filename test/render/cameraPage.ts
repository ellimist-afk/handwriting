/**
 * The page half of the camera/scale measurement: a real Obsidian-shaped
 * editor subtree under the REAL Minimal stylesheet, driven through the REAL
 * camera code the overlay runs.
 *
 * The node half (`MinimalCameraScale.test.ts`) supplies the stylesheets, the
 * injected app variables and every citation. Nothing here decides anything:
 * it builds the DOM, applies a perturbation, and reports numbers.
 *
 * WHAT IS REAL HERE, and it is the whole point of the file:
 *   - `contentOriginLeft`, `effectiveScale`, `fontZoomFactor`, `visualToNote`
 *     and `noteToVisual` are imported from `src/`, not copied.
 *   - the camera is the real `Camera`, driven by the same three arguments
 *     `InkOverlay.syncCamera` passes to `setState`.
 *   - the overlay container is sized by the real `bandFor`, from the real
 *     scroller viewport, the way `InkOverlay.syncBand` sizes it.
 *   - the pen-down conversion is the real router arithmetic
 *     (`visualToNote(clientX - rect.left, cssScale)` then
 *     `camera.screenToWorld`), and the paint conversion is its inverse
 *     (`camera.worldToScreen` then `noteToVisual(..., cssScale)` plus the
 *     container's own left).
 *
 * So a discrepancy reported by this file is a discrepancy in the shipped
 * chain, not in a restatement of it.
 *
 * WHAT IS NOT REAL: there is no Obsidian and no CodeMirror. `.cm-*` boxes are
 * built by hand and every value Obsidian's `app.css` would have supplied is
 * INJECTED by the node half as a named parameter. The fixture therefore
 * asserts its own preconditions (column width, centring, `.cm-content` full
 * width) before any conclusion is drawn from it.
 */

import { contentOriginLeft } from "../../src/inline/ContentOrigin";
import {
	effectiveScale,
	fontZoomFactor,
	noteToVisual,
	visualToNote,
} from "../../src/inline/ZoomScale";
import { bandFor, type BandViewport } from "../../src/inline/ScrollBand";
import { Camera } from "../../src/camera/Camera";

/** One `syncCamera` worth of state, plus the ground truth beside it. */
export interface SyncState {
	/** The overlay container's visual left - `overlay.left` in syncCamera. */
	overlayLeft: number;
	/** Its visual top - `overlay.top` in syncCamera. */
	overlayTop: number;
	/** Its visual width - the numerator of `effectiveScale`. */
	overlayVisualWidth: number;
	/** Its `offsetWidth` - the denominator, and an INTEGER by spec. */
	overlayLayoutWidth: number;
	/** `effectiveScale(...)`: visual px per layout px. */
	cssScale: number;
	/** `.cm-content`'s resolved font-size, in px. */
	fontPx: number;
	/** `fontZoomFactor(fontPx, refFontPx)`. */
	fontZoom: number;
	/** `cssScale * fontZoom` - what the pen divides by and the paint multiplies by. */
	scale: number;
	/** `contentOriginLeft(contentDOM)` - where note space starts on screen. */
	origin: number;
	/** `.cm-content`'s own left - what the overlay read before 1.4.9. */
	contentLeft: number;
	/** `.cm-content`'s border-box width. */
	contentWidth: number;
	/** A plain text line's left and width: the column, measured directly. */
	lineLeft: number;
	lineWidth: number;
	/** The line's own `offsetWidth`, so its visual/layout ratio is comparable. */
	lineLayoutWidth: number;
	/** The marker's left: the thing ink is supposed to stay under. */
	markX: number;
	/**
	 * The line's resolved `padding-left`, in px. This is the FIXED-px part of
	 * the marker's offset from the column - the part that does not grow when
	 * the font does - and it is the whole of the residual the font-zoom model
	 * leaves behind.
	 */
	linePaddingLeft: number;
	/** The marker's offset from the line's border-box left. */
	markOffsetInLine: number;
	/** The root font size, because `--line-width: 40rem` is built on it. */
	rootFontPx: number;
}

export interface Capture {
	/** Note-space x the pen would have persisted for the marker. */
	world: number;
	at: SyncState;
}

export type ResyncMode = "full" | "syncOnly" | "none";

export interface LawProbe {
	/** Where the reduced law says the stroke is painted, in visual px. */
	predicted: number;
	/** Where the marker actually is now, in visual px. */
	actual: number;
	/** predicted - actual. Positive means ink sits RIGHT of its word. */
	error: number;
	before: SyncState;
	after: SyncState;
	world: number;
	mode: ResyncMode;
}

interface CameraApi {
	build(): void;
	setPaneWidth(px: number): void;
	setReadable(on: boolean): void;
	setEditorFontPx(px: number): void;
	setRootFontPx(px: number): void;
	syncBand(): void;
	sync(): SyncState;
	capture(): Capture;
	probe(cap: Capture, mode: ResyncMode): LawProbe;
	displacement(): { M: number; contentLeft: number; origin: number; contentWidth: number; lineLeft: number; lineWidth: number; paneWidth: number };
	ancestorTransforms(): AncestorNote[];
}

/** One ancestor of the editor and the properties that could scale it. */
export interface AncestorNote {
	tag: string;
	cls: string;
	transform: string;
	zoom: string;
	scale: string;
	contain: string;
	filter: string;
	perspective: string;
	/** rect.width / offsetWidth for this element, or null when unmeasurable. */
	ratio: number | null;
}

declare global {
	interface Window {
		__hwcam: CameraApi;
	}
}

const el = (tag: string, cls: string): HTMLElement => {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	return node;
};

/** Set once, at the first `sync()`, exactly as `handleResize` sets it. */
let refFontPx = 0;
/**
 * The overlay's cached zoom factor. Since 1.4.10 `syncCamera` refreshes it
 * too, on a string compare against `cachedFontStr` - the same compare
 * production makes against `this.lastFontStr`.
 */
let cachedFontZoom = 1;
/** `InkOverlay.lastFontStr`: the resolved `font-size` string last read. */
let cachedFontStr = "";
/** The overlay's cached transform scale. `syncCamera` DOES refresh this. */
let cachedCssScale = 1;
const camera = new Camera();

function need(id: string): HTMLElement {
	const node = document.getElementById(id);
	if (!(node instanceof HTMLElement)) throw new Error(`fixture not built: #${id}`);
	return node;
}

function build(): void {
	document.body.innerHTML = "";
	refFontPx = 0;
	cachedFontZoom = 1;
	cachedFontStr = "";
	cachedCssScale = 1;

	// The real chain of Obsidian containers, because Minimal selects on
	// `.view-content >`, `.workspace-leaf-content[data-type=markdown]` and
	// `.markdown-source-view.mod-cm6.is-readable-line-width` - a fixture that
	// skipped one of them would be styled by a different cascade.
	const app = el("div", "app-container");
	const main = el("div", "horizontal-main-container");
	const workspace = el("div", "workspace");
	const split = el("div", "workspace-split mod-vertical mod-root");
	const tabs = el("div", "workspace-tabs mod-top mod-active");
	const tabContainer = el("div", "workspace-tab-container");
	const leaf = el("div", "workspace-leaf");
	const leafContent = el("div", "workspace-leaf-content");
	leafContent.setAttribute("data-type", "markdown");
	leafContent.setAttribute("data-mode", "source");
	leafContent.id = "leaf-content";
	const viewContent = el("div", "view-content");
	const sourceView = el(
		"div",
		"markdown-source-view cm-s-obsidian mod-cm6 is-live-preview is-readable-line-width"
	);
	sourceView.id = "source-view";
	const editor = el("div", "cm-editor");
	editor.id = "editor";
	const scroller = el("div", "cm-scroller");
	scroller.id = "scroller";
	const sizer = el("div", "cm-sizer");
	sizer.id = "sizer";
	const container = el("div", "cm-contentContainer");
	const content = el("div", "cm-content cm-lineWrapping");
	content.id = "content";
	content.setAttribute("contenteditable", "true");

	// HAZARD, carried over from ContentOriginColumn.test.ts: a zero-size block
	// marker centres on a POINT under `margin-inline: auto`, so it must not be
	// allowed to be the origin.
	const marker = el("div", "hw-block-marker");
	marker.id = "block-marker";
	marker.style.width = "0px";
	marker.style.height = "0px";
	content.appendChild(marker);

	for (let i = 0; i < 4; i++) {
		const line = el("div", "cm-line");
		line.id = `line${i}`;
		// A FONT-INDEPENDENT ruler. The CI runner is Linux and fontless, so a
		// measurement built on glyph advances would measure whatever face
		// fontconfig substituted. An inline-block sized in `em` has a width
		// the engine computes from the font SIZE alone - no face, no hinting,
		// no kerning - so the marker's offset from the column is exactly
		// `SHIM_EM * fontPx` under every font stack on every machine.
		const shim = el("span", "hw-shim");
		shim.style.display = "inline-block";
		shim.style.width = "12em";
		shim.style.height = "1em";
		shim.style.verticalAlign = "baseline";
		line.appendChild(shim);
		const mark = el("span", "hw-mark");
		mark.id = `mark${i}`;
		mark.style.display = "inline-block";
		mark.style.width = "2em";
		mark.style.height = "1em";
		line.appendChild(mark);
		content.appendChild(line);
	}

	container.appendChild(content);
	sizer.appendChild(container);
	scroller.appendChild(sizer);

	// The overlay, where the plugin puts it: a positioned child of the
	// SCROLLER, sized later by `bandFor`.
	const overlay = el("div", "handwriting-ink-overlay");
	overlay.id = "overlay";
	overlay.style.position = "absolute";
	overlay.style.left = "0";
	overlay.style.top = "0";
	overlay.style.width = "0";
	overlay.style.height = "0";
	overlay.style.overflow = "hidden";
	overlay.style.pointerEvents = "none";
	overlay.style.zIndex = "250";
	scroller.appendChild(overlay);

	editor.appendChild(scroller);
	sourceView.appendChild(editor);
	viewContent.appendChild(sourceView);
	leafContent.appendChild(viewContent);
	leaf.appendChild(leafContent);
	tabContainer.appendChild(leaf);
	tabs.appendChild(tabContainer);
	split.appendChild(tabs);
	workspace.appendChild(split);
	main.appendChild(workspace);
	app.appendChild(main);
	document.body.appendChild(app);

	// `InkOverlay.mount` promotes the scroller to `position: relative` when it
	// is static. Same call, same reason: the band is positioned against it.
	if (getComputedStyle(scroller).position === "static") {
		scroller.style.position = "relative";
	}
}

function setPaneWidth(px: number): void {
	const leafContent = need("leaf-content");
	leafContent.style.width = `${px}px`;
	leafContent.style.height = "760px";
}

function setReadable(on: boolean): void {
	need("source-view").classList.toggle("is-readable-line-width", on);
}

/**
 * Obsidian's editor font size. Minimal derives its own
 * `--font-adaptive-normal` from `--font-text-size` (theme.css:579), so this
 * sets the app variable and lets the theme's own cascade decide the rest -
 * rather than setting a font-size on the editor and pretending that is what
 * the setting does.
 */
function setEditorFontPx(px: number): void {
	document.body.style.setProperty("--font-text-size", `${px}px`);
}

/** The root font size `--line-width: 40rem` (theme.css:53) is built on. */
function setRootFontPx(px: number): void {
	document.documentElement.style.fontSize = `${px}px`;
}

/** `InkOverlay.syncBand`, verbatim in effect: the real `bandFor`, applied. */
function syncBand(): void {
	const scroller = need("scroller");
	const overlay = need("overlay");
	const viewport: BandViewport = {
		scrollLeft: scroller.scrollLeft,
		scrollTop: scroller.scrollTop,
		clientWidth: scroller.clientWidth,
		clientHeight: scroller.clientHeight,
		scrollWidth: scroller.scrollWidth,
		scrollHeight: scroller.scrollHeight,
	};
	const band = bandFor(viewport);
	overlay.style.left = `${band.left}px`;
	overlay.style.top = `${band.top}px`;
	overlay.style.width = `${band.width}px`;
	overlay.style.height = `${band.height}px`;
}

function measure(fontZoom: number, cssScale: number): SyncState {
	const overlay = need("overlay");
	const content = need("content");
	const line = need("line2");
	const mark = need("mark2");
	const rect = overlay.getBoundingClientRect();
	const c = content.getBoundingClientRect();
	const l = line.getBoundingClientRect();
	const fontPx = Number.parseFloat(getComputedStyle(content).fontSize);
	const markLeft = mark.getBoundingClientRect().left;
	return {
		overlayLeft: rect.left,
		overlayTop: rect.top,
		overlayVisualWidth: rect.width,
		overlayLayoutWidth: overlay.offsetWidth,
		cssScale,
		fontPx,
		fontZoom,
		scale: cssScale * fontZoom,
		origin: contentOriginLeft(content) ?? c.left,
		contentLeft: c.left,
		contentWidth: c.width,
		lineLeft: l.left,
		lineWidth: l.width,
		lineLayoutWidth: line.offsetWidth,
		markX: markLeft,
		linePaddingLeft: Number.parseFloat(getComputedStyle(line).paddingLeft),
		markOffsetInLine: markLeft - l.left,
		rootFontPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
	};
}

/**
 * `handleResize` + `syncCamera`, in that order - the state the overlay
 * reaches once BOTH observers have run. `refFontPx` latches on the first
 * call, which is what mount does.
 */
function sync(): SyncState {
	const overlay = need("overlay");
	const content = need("content");
	cachedFontStr = getComputedStyle(content).fontSize;
	const fontPx = Number.parseFloat(cachedFontStr);
	if (refFontPx <= 0 && Number.isFinite(fontPx) && fontPx > 0) refFontPx = fontPx;
	cachedFontZoom = fontZoomFactor(fontPx, refFontPx);
	cachedCssScale = effectiveScale({
		visualWidth: overlay.getBoundingClientRect().width,
		layoutWidth: overlay.offsetWidth,
	});
	return applyCamera();
}

/**
 * `syncCamera` ALONE - the `contentResizeObserver` path, which is the one that
 * fires by itself when the editor font size changes.
 *
 * Until 1.4.10 it re-measured `cssScale` and left `this.fontZoom` at whatever
 * `handleResize` last cached, which is the defect this file measured: 48px at
 * a 1400px pane going 16px to 20px. It now refreshes the font zoom from the
 * same computed style, on a string compare, and multiplies the total scale
 * unconditionally rather than only inside the epsilon branch.
 */
function syncCameraOnly(): SyncState {
	const overlay = need("overlay");
	const measured = effectiveScale({
		visualWidth: overlay.getBoundingClientRect().width,
		layoutWidth: overlay.offsetWidth,
	});
	// The real epsilon guard: a wobble in the last decimals is not adopted.
	if (Math.abs(measured - cachedCssScale) > cachedCssScale * 1e-3) {
		cachedCssScale = measured;
	}
	// `refFontPx` is not touched: it latches at mount, in `sync()`.
	const fontStr = getComputedStyle(need("content")).fontSize;
	if (fontStr !== cachedFontStr) {
		cachedFontStr = fontStr;
		cachedFontZoom = fontZoomFactor(Number.parseFloat(fontStr), refFontPx);
	}
	return applyCamera();
}

/** The three arguments `InkOverlay.syncCamera` hands `camera.setState`. */
function applyCamera(): SyncState {
	const state = measure(cachedFontZoom, cachedCssScale);
	const documentTop = need("content").getBoundingClientRect().top;
	camera.setState(
		visualToNote(state.overlayLeft - state.origin, state.scale),
		visualToNote(state.overlayTop - documentTop, state.scale),
		state.fontZoom
	);
	return state;
}

/**
 * Pen-down on the marker, through the real router arithmetic: a clientX is
 * made overlay-local in LAYOUT px by dividing out `cssScale`, then
 * `screenToWorld` divides out the camera's zoom.
 */
function capture(): Capture {
	const at = sync();
	const local = visualToNote(at.markX - at.overlayLeft, at.cssScale);
	return { world: camera.screenToWorld(local, 0).x, at };
}

function probe(cap: Capture, mode: ResyncMode): LawProbe {
	if (mode === "full") {
		syncBand();
		sync();
	} else if (mode === "syncOnly") {
		syncBand();
		syncCameraOnly();
	}
	const after = measure(cachedFontZoom, cachedCssScale);
	// The paint: world -> canvas layout px through the camera, then canvas
	// layout px -> visual px through the container's own rect.
	const screen = camera.worldToScreen(cap.world, 0).x;
	const predicted = after.overlayLeft + noteToVisual(screen, after.cssScale);
	return {
		predicted,
		actual: after.markX,
		error: predicted - after.markX,
		before: cap.at,
		after,
		world: cap.world,
		mode,
	};
}

/**
 * The one-time shift a note carries when it is opened on 1.4.9 or later:
 * `contentOriginLeft` minus the pre-1.4.9 origin, `.cm-content`'s own left.
 */
function displacement(): {
	M: number;
	contentLeft: number;
	origin: number;
	contentWidth: number;
	lineLeft: number;
	lineWidth: number;
	paneWidth: number;
} {
	const content = need("content");
	const line = need("line2");
	const c = content.getBoundingClientRect();
	const l = line.getBoundingClientRect();
	const origin = contentOriginLeft(content) ?? c.left;
	return {
		M: origin - c.left,
		contentLeft: c.left,
		origin,
		contentWidth: c.width,
		lineLeft: l.left,
		lineWidth: l.width,
		paneWidth: need("leaf-content").getBoundingClientRect().width,
	};
}

/**
 * Every ancestor from the overlay's parent up to `<html>`, with the four
 * properties that can put a scale between layout px and visual px, plus that
 * element's own measured ratio. A theme that scales an ancestor shows up
 * here as a ratio away from 1 - and, crucially, so does one that scales the
 * TEXT's ancestors without scaling the overlay's.
 */
function ancestorTransforms(): AncestorNote[] {
	const notes: AncestorNote[] = [];
	let node: HTMLElement | null = need("overlay");
	while (node) {
		const cs = getComputedStyle(node);
		const rect = node.getBoundingClientRect();
		const layout = node.offsetWidth;
		notes.push({
			tag: node.tagName.toLowerCase(),
			cls: node.className || "(none)",
			transform: cs.transform,
			zoom: cs.zoom,
			scale: cs.scale,
			contain: cs.contain,
			filter: cs.filter,
			perspective: cs.perspective,
			ratio: layout > 0 ? rect.width / layout : null,
		});
		node = node.parentElement;
	}
	return notes;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
	window.__hwcam = {
		build,
		setPaneWidth,
		setReadable,
		setEditorFontPx,
		setRootFontPx,
		syncBand,
		sync,
		capture,
		probe,
		displacement,
		ancestorTransforms,
	};
}
