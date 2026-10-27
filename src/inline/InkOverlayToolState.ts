/**
 * The note surface's module-level tool and setting state, split out of
 * InkOverlay.ts: which nib the tip draws, the ink size per tool, the TipMode
 * wrappers (eraser, lasso, space, pan), the eraser radius, the toolbar corner,
 * the strip surfaces other ink surfaces register, the reticle, whole-stroke
 * eraser and shape-snap flags, and the hooks that persist them.
 *
 * InkOverlay.ts re-exports every exported name here, so each importer keeps its
 * import line. Three names come back from InkOverlay.ts (`instances`,
 * `refreshAllStrips`, `prepareFingerInkEverywhere`), so the two modules form a
 * cycle. Every read of them is inside a function body or the tip-mode listener;
 * none runs while either module loads.
 */
import { Notice } from "obsidian";
import { routineNoticesVisible } from "../diag/RoutineNotices";
import { DEFAULT_ERASER_RADIUS_PX, clampEraserRadius } from "../ink/EraserSize";
import { applyInkColor } from "../ink/InkColor";
import { clampInkSize } from "../ink/InkSize";
import { InkTool } from "../ink/Stroke";
import { markToolPicked } from "./MouseInk";
import {
	releaseTipMode,
	setTipModeListener,
	tipMode,
	tipModeHeld as tipModeHeldNow,
	toggleTipMode,
} from "./TipMode";
import {
	DEFAULT_TOOLBAR_CORNER,
	ToolbarCorner,
	normalizeToolbarCorner,
} from "./ToolbarCorner";
import { instances, prepareFingerInkEverywhere, refreshAllStrips } from "./InkOverlay";

/**
 * What the pen TIP draws: pen or highlighter. This is a property of the nib
 * (like its color), not an interaction mode. The eraser end and the side button
 * keep their hardware meanings regardless. Session-scoped; switched by command.
 */
export let inlineTool: InkTool = "pen";

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
	const size = clampInkSize(mult);
	if (inkSizeMult[tool] === size) return;
	inkSizeMult[tool] = size;
	// A held snap shows the shape at the old size; it goes. A size applied again
	// unchanged (a settings sync applies both) leaves it.
	for (const overlay of instances) overlay.clearSnapPreview();
}

export function getInlineTool(): InkTool {
	return inlineTool;
}

export function setInlineTool(tool: InkTool): void {
	inlineTool = tool;
	for (const overlay of instances) overlay.clearSnapPreview();
	// THE NIB HALF OF "a tool has been picked" (MouseInk.ts, `toolPicked`).
	// Here rather than in the two tool commands, the strip's two nib buttons,
	// the colour commands and the quick-pen chips, because every one of them
	// ends in this line and a rule written at all six drifts at one of them.
	// The mouse-draws-from-a-lit-tool grant on a pen-less device reads that
	// flag; on a device that has seen a pen nothing reads it at all.
	markToolPicked();
	// Picking a nib is how you put every other mode away - not just the
	// eraser. While this cleared one flag of four, "Switch between pen and
	// highlighter" left the tip panning while announcing a nib change.
	releaseTipMode();
	// Commands and strip buttons both end here. If that pick makes iPhone
	// finger ink eligible, commit its pre-contact guard on every mounted note;
	// a toolbar-only hook would leave command entry in a native-scroll window.
	prepareFingerInkEverywhere();
}

/**
 * Eraser mode (v0.13.13).
 *
 * The pen normally decides what it is at contact and needs no mode at all:
 * eraser end erases, side button lassos, tip inks. That only works on a pen that
 * HAS an eraser end. Plenty do not, and on those the eraser was unreachable.
 *
 * So: an explicit mode, off by default, that makes the tip erase. Hardware
 * keeps every meaning it had. The eraser end still erases whatever the mode
 * says, and choosing a nib turns the mode off.
 */
/**
 * The tip's mode lives in TipMode.ts (DOM-free, so it can be tested). The
 * exported wrappers below are the names the rest of the plugin already calls.
 */
setTipModeListener(() => {
	for (const p of instances) p.refreshStrip();
	refreshStripSurfaces();
	// §5o: switching the tip to anything but lasso dissolves the selection
	// on every surface, immediately - Alan's device finding 2026-09-02 ("the
	// lasso selector remains" after a tool switch; before, only the NEXT
	// non-lasso pen contact cleared it).
	if (tipMode() !== "lasso") {
		for (const p of instances) p.dissolveSelection();
		for (const fn of tipModeSurfaces) fn();
	}
});

export function getInlineEraserMode(): boolean {
	return tipMode() === "eraser";
}

/** Eraser, lasso and space modes are exclusive: the tip can only be one thing. */
export function setInlineEraserMode(on: boolean): void {
	toggleTipMode("eraser", on);
}

export function getInlineLassoMode(): boolean {
	return tipMode() === "lasso";
}

/**
 * Lasso as a MODE (roadmap: pen GUI): the side button was the only way
 * in, and iPads and mice have no side button. While on, the tip lassos.
 */
export function setInlineLassoMode(on: boolean): void {
	toggleTipMode("lasso", on);
}

export function getInlineSpaceMode(): boolean {
	return tipMode() === "space";
}

/**
 * Insert space as a MODE, same grammar as eraser and lasso: while on, the
 * tip plants a divider and everything below it follows the pen vertically.
 * The side button and the eraser end keep their hardware meanings.
 */
export function setInlineSpaceMode(on: boolean): void {
	toggleTipMode("space", on);
}

/** True while any mode has taken the tip away from the nib. */
export function tipModeHeld(): boolean {
	return tipModeHeldNow();
}

/** Hand the tip back to the active nib, whichever mode was holding it. */
export function releaseTipModes(): void {
	releaseTipMode();
}

export function getInlinePanMode(): boolean {
	return tipMode() === "pan";
}

/**
 * Pan as a MODE, same grammar as lasso and insert space: while on, the tip
 * drags the view instead of inking. Touch already pans by finger, but a pen
 * user working on glass has no way to move the page without putting the pen
 * down - and on a Surface the fingers are usually holding the thing.
 */
export function setInlinePanMode(on: boolean): void {
	toggleTipMode("pan", on);
}

/** Eraser radius in screen px, shared by the hit test and both cursors. */
export let inlineEraserRadiusPx: number = DEFAULT_ERASER_RADIUS_PX;

export function getEraserRadiusPx(): number {
	return inlineEraserRadiusPx;
}

export function setEraserRadiusPx(px: number): void {
	inlineEraserRadiusPx = clampEraserRadius(px);
}

/**
 * The eraser slider changes module state live and persists on release;
 * persistence lives with the plugin, which registers here at load.
 */
let persistEraserRadius: ((px: number) => void) | null = null;

export function setPersistEraserRadius(fn: ((px: number) => void) | null): void {
	persistEraserRadius = fn;
}

// Settings-tab flags (1.0.5), device-level like the modes above them.
export let toolbarCorner: ToolbarCorner = DEFAULT_TOOLBAR_CORNER;

export function getToolbarCorner(): ToolbarCorner {
	return toolbarCorner;
}

/**
 * Surfaces that carry a strip but are not inline overlays.
 *
 * The fan-outs below walk `instances`, which is the editor overlays and
 * nothing else - so a corner change, or a tip-mode change, reached every open
 * NOTE and no open PDF. The PDF controller has had its own refreshStrip all
 * along; nothing ever called it. A callback rather than a second registry of
 * controllers, because this module is already imported by the PDF surface and
 * importing back would close the loop.
 */
const stripSurfaces = new Set<() => void>();

/**
 * §5o: the same non-editor surfaces also need to know when a tool change
 * should put a selection away, kept in its own set so a surface can register
 * a strip refresh without one, or vice versa.
 */
const tipModeSurfaces = new Set<() => void>();

/**
 * And the same surfaces need to know when a RENDER-TIME setting changed the
 * committed geometry under them. `repaintAllInkOverlays` walked `instances`,
 * which is the editor overlays and nothing else, so flipping Ink smoothing or
 * pressure sensitivity left every open PDF and every page view showing ink in
 * the old shape until something unrelated happened to repaint it - on the
 * surface the plugin calls the headline use for writing.
 */
export const repaintSurfaces = new Set<() => void>();

/**
 * And the same surfaces need to hear the mouse-ink OFF edge, because that
 * edge can strand a reticle. Its own set, not `stripSurfaces`: a strip
 * refresh runs on every corner change and every tip-mode change, and hiding
 * a live reticle on those would take the ring out from under a pen that is
 * still hovering.
 */
export const hideCursorSurfaces = new Set<() => void>();

/**
 * And the same surfaces need to hear the pen going OFF while a stroke of
 * theirs is live, because the router refuses new claims without breaking the
 * one it already made (`InlinePenCallbacks.penOff`). Its own set for the same
 * reason as the one above: a strip refresh is not a stroke end, and ending a
 * live stroke on every corner change would take the word out from under a pen
 * that is still writing.
 *
 * The pen-off state was note-only when this fan-out did not exist, so a pdf
 * had nothing live to end. It is not note-only any more ("why would you take
 * keyboard mode away from pdf"), and a pdf whose stroke was left running would
 * hold `activePenId` with the window-capture click suppressor armed behind it
 * - the failure `abandonActiveStroke` was written for, reached a different
 * way.
 */
export const endStrokeSurfaces = new Set<(preserveMouse?: boolean) => void>();

/** Register an extra strip to refresh with the editors. Returns the undo. */
export function addStripSurface(
	refresh: () => void,
	onTipMode?: () => void,
	onRepaint?: () => void,
	onHideCursor?: () => void,
	onEndLiveStroke?: (preserveMouse?: boolean) => void
): () => void {
	stripSurfaces.add(refresh);
	if (onTipMode) tipModeSurfaces.add(onTipMode);
	if (onRepaint) repaintSurfaces.add(onRepaint);
	if (onHideCursor) hideCursorSurfaces.add(onHideCursor);
	if (onEndLiveStroke) endStrokeSurfaces.add(onEndLiveStroke);
	return () => {
		stripSurfaces.delete(refresh);
		if (onTipMode) tipModeSurfaces.delete(onTipMode);
		if (onRepaint) repaintSurfaces.delete(onRepaint);
		if (onHideCursor) hideCursorSurfaces.delete(onHideCursor);
		if (onEndLiveStroke) endStrokeSurfaces.delete(onEndLiveStroke);
	};
}

export function refreshStripSurfaces(): void {
	for (const refresh of stripSurfaces) refresh();
}

/** Settings changed the corner: every open editor's strip moves at once. */
export function setToolbarCorner(corner: ToolbarCorner): void {
	toolbarCorner = corner;
	for (const p of instances) p.applyToolbarCorner();
	refreshStripSurfaces();
}

/** The placement changed live and has to survive a restart; the plugin owns
 * data.json, so it registers the write here at load. */
let persistToolbarCorner: ((corner: ToolbarCorner) => void) | null = null;

export function setPersistToolbarCorner(fn: ((corner: ToolbarCorner) => void) | null): void {
	persistToolbarCorner = fn;
}

/**
 * Move the toolbar and remember it: `applyInkSize`'s shape, for the other
 * setting a strip can now change on its own.
 *
 * ONE ROAD, and this is the whole point of the function. The placement has
 * two writers since drag-to-anchor (1.4.12) - the settings dropdown and a
 * drag of the strip's grip - and each of them owes the other's half: a drop
 * that only called `setToolbarCorner` would move the toolbar until the next
 * restart and leave the dropdown reading the placement it had before, and one
 * that only wrote settings would persist a move nobody could see. The
 * dropdown's `case "toolbarCorner"` (main.ts) calls this, and both strip
 * hosts wire `MobileToolsHost.setPlacement` to it, so there is nothing to
 * keep level.
 *
 * The value is NORMALISED here rather than trusted, for the same reason
 * `setStripFoldOrder` normalises: a caller that has not is then safe, and
 * both of today's callers already had to.
 */
export function applyToolbarPlacement(corner: ToolbarCorner): void {
	const safe = normalizeToolbarCorner(corner);
	setToolbarCorner(safe);
	persistToolbarCorner?.(safe);
}

export let penReticleOn = true;
export let eraserWholeStrokes = true;
export let shapeSnapOn = true;

export function setShapeSnap(on: boolean): void {
	shapeSnapOn = on;
	if (!on) for (const overlay of instances) overlay.clearSnapPreview();
}

export function setPenReticle(on: boolean): void {
	penReticleOn = on;
}

export function penReticleEnabled(): boolean {
	return penReticleOn;
}

export function setEraserWholeStrokes(on: boolean): void {
	eraserWholeStrokes = on;
}

export function getEraserWholeStrokes(): boolean {
	return eraserWholeStrokes;
}

/** The strip's chips persist through here on flip (settings stay agreed). */
export let persistEraserMode: ((on: boolean) => void) | null = null;

export function setPersistEraserMode(fn: ((on: boolean) => void) | null): void {
	persistEraserMode = fn;
}

/**
 * A way in for a host that cannot reach `persistEraserMode` itself. The note
 * host pairs `setEraserWholeStrokes(on)` with `persistEraserMode?.(on)`
 * inline (the strip spec below) because both live in this module; the PDF
 * host builds its strip spec in a different file and needs a call to make
 * the same pairing there.
 */
export function persistEraserModeNow(on: boolean): void {
	persistEraserMode?.(on);
}

/**
 * A strip swatch was tapped: pick up the nib that wears this color, apply
 * and persist it, say so. One function serving BOTH strips (notes and pdf),
 * because the swatches must not depend on the per-name color commands -
 * those are registered behind an off-by-default setting, and a fresh
 * install had a palette of dead swatches (audit, 2026-08-31).
 */
export function pickStripColor(name: string, hex: string): void {
	const tool = getInlineTool();
	// Choosing a color reaches for the nib that wears it: every mode that
	// holds the tip lets go, the same exits the nib commands make.
	setInlineEraserMode(false);
	setInlineLassoMode(false);
	setInlineSpaceMode(false);
	setInlinePanMode(false);
	applyInkColor(tool, hex);
	// Every strip, not just the tapped one: exiting a mode here must dim
	// its light on every open pane, exactly as the commands do.
	refreshAllStrips();
	if (routineNoticesVisible()) new Notice(`Handwriting: ${tool} ${name}`);
}

export function commitEraserRadius(): void {
	persistEraserRadius?.(inlineEraserRadiusPx);
}

/** Same shape for the nib-size sliders: live module state, plugin persists. */
export let persistInkSize: ((tool: InkTool, mult: number) => void) | null = null;

export function setPersistInkSize(fn: ((tool: InkTool, mult: number) => void) | null): void {
	persistInkSize = fn;
}

/**
 * Set and persist a tool's nib size in one move: `applyInkColor`'s twin for
 * the other half of a pen (InkColor.ts).
 *
 * The pair was already written twice - inline in each strip host's
 * `setInkSizeMult(tool, mult, commit)` - because `persistInkSize` is module
 * state here and only this file could reach it. Quick pens (1.4.12 §4) is the
 * third caller and the first one OUTSIDE this module, and a preset must land
 * by the same road a slider release does or the two persist differently.
 * The clamped value is what gets persisted, never the caller's raw number.
 */
export function applyInkSize(tool: InkTool, mult: number): void {
	setInkSizeMult(tool, mult);
	persistInkSize?.(tool, getInkSizeMult(tool));
}
