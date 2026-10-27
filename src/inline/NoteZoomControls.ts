/**
 * The note zoom controls: the zoom bar's buttons, the step-aside edge it shares with the strip, and the registry of live bars.
 * They are re-exported from MobileTools.ts, so every importer keeps its import line.
 */
import { getNoteZoomControlsMode, getZoomBarCanvasEnabled, noteZoomControlsVisibleWithCanvas, onNoteZoomControlsChanged } from "./NoteZoomControlsMode";
// The per-note override of Infinite Canvas. Read-only from here: the strip
// asks what this note's mode is and subscribes to changes; who may write the
// override is main.ts's business, not the strip's.
import { canvasForNote, onCanvasOverrideChanged } from "./CanvasNoteOverride";
import { MAX_PINCH_SCALE } from "./PinchScale";
import { type MobileToolsHost } from "./MobileToolsHost";

const liveNoteZoomControls = new Set<NoteZoomControls>();

/**
 * Push a canvas change into every strip already on screen.
 *
 * `setStripFoldOrder`'s shape, for its reason, and needed for the same kind of
 * change: the global Infinite Canvas row is written in main.ts and the zoom
 * bar's own mode has a listener while the canvas has none, so without this a
 * user turning the canvas off would keep a zoom bar until the pane was rebuilt
 * - the "only applies on restart" defect the override's listener was written
 * to avoid. The per-note case comes in through each control's own subscription;
 * this is the global half.
 */
export function refreshNoteZoomControlsAll(): void {
	for (const controls of liveNoteZoomControls) controls.refresh();
}

/** Note zoom chrome has its own lifetime; a note need not have a pen strip. */
/**
 * How long the chrome stays invisible after a lift before it fades back
 * (styles.css: the base rules' `opacity 60ms linear 160ms`).
 */
const STEP_BACK_MS = 160;

/**
 * One step-aside edge for a set of chrome elements that hide together.
 *
 * `is-inking` fades them out by opacity and makes them unhittable. When it
 * comes off, they are still invisible for STEP_BACK_MS, and `visibility`
 * used to keep them unhittable through that delay; a visibility transition
 * cannot run on the compositor, so it is gone, and `is-stepping-back` carries
 * the delay instead: on at the lift, off when the fade starts, or at once if
 * the pen comes down again first. Class toggles and one timer, no reads.
 */
export class StepAside {
	private hidden = false;
	private timer: number | null = null;
	private win: Window | null = null;
	constructor(private readonly els: () => readonly HTMLElement[]) {}
	set(hide: boolean): void {
		// refresh() re-applies the current state; that must not cut a
		// running return delay short.
		if (hide === this.hidden) return;
		this.hidden = hide;
		this.cancel();
		const els = this.els();
		// The window the chrome lives in (a popout has its own); none for a
		// detached element, which has no delay to keep.
		const view = els[0]?.ownerDocument?.defaultView;
		const win = typeof view?.setTimeout === "function" ? view : null;
		const lifted = !hide && win !== null;
		for (const el of els) {
			el.toggleClass("is-inking", hide);
			el.toggleClass("is-stepping-back", lifted);
		}
		if (!lifted) return;
		this.win = win;
		this.timer = win.setTimeout(() => {
			this.timer = null;
			for (const el of this.els()) el.toggleClass("is-stepping-back", false);
		}, STEP_BACK_MS);
	}
	cancel(): void {
		if (this.timer === null) return;
		this.win?.clearTimeout(this.timer);
		this.timer = null;
	}
}

export class NoteZoomControls {
	readonly element: HTMLElement;
	private readonly buttons: HTMLButtonElement[] = [];
	private inking = false;
	private readonly stepAside = new StepAside(() => [this.element]);
	private stopModeWatch: (() => void) | null = null;
	private stopCanvasOverrideWatch: (() => void) | null = null;

	constructor(parent: HTMLElement, private readonly host: Pick<MobileToolsHost, "noteViewport" | "notePath">) {
		const viewport = host.noteViewport;
		if (!viewport) throw new Error("note zoom controls need a note viewport");
		this.element = parent.createDiv({cls:"handwriting-note-viewport-controls",attr:{role:"group","aria-label":"Note zoom"}});
		for (const [label, value, action] of [
			["Zoom out", "−", () => viewport.zoomNoteBy(.5)],
			["Reset note zoom to 100%", "100%", () => viewport.resetNoteZoom()],
			["Zoom in", "+", () => viewport.zoomNoteBy(2)],
			["Fit handwriting", "Fit", () => viewport.fitHandwriting()],
		] as const) {
			const button = this.element.createEl("button", {text:value,attr:{type:"button","aria-label":label,title:label}});
			button.addEventListener("pointerdown", e => e.preventDefault());
			button.addEventListener("click", () => { action(); this.refresh(); });
			this.buttons.push(button);
		}
		this.refresh();
		liveNoteZoomControls.add(this);
		this.stopModeWatch = onNoteZoomControlsChanged(() => this.refresh());
		this.stopCanvasOverrideWatch = onCanvasOverrideChanged(path => {
			if (this.host.notePath?.() === path) this.refresh();
		});
	}

	refresh(): void {
		const state = this.host.noteViewport?.getNoteViewportState();
		if (state) this.buttons.forEach((button, i) => {
			button.disabled = state.busy || (i === 3 && !state.fitAvailable) || (i === 2 && state.zoom >= MAX_PINCH_SCALE);
			if (i === 1) button.textContent = `${Number((state.zoom * 100).toPrecision(3))}%`;
		});
		const path = this.host.notePath?.() ?? null;
		this.element.toggleClass("is-hidden", !noteZoomControlsVisibleWithCanvas(
			getNoteZoomControlsMode(), canvasForNote(path, getZoomBarCanvasEnabled())
		));
		this.setInking(this.inking);
	}

	setInking(on: boolean): void {
		this.inking = on;
		this.stepAside.set(on && getNoteZoomControlsMode() === "auto");
	}

	penUp(): void {
		this.setInking(false);
		// The gesture clears mode and builder after this call. Read the ready state then.
		queueMicrotask(() => { if (liveNoteZoomControls.has(this)) this.refresh(); });
	}

	destroy(): void {
		this.stopModeWatch?.();
		this.stopCanvasOverrideWatch?.();
		this.stopModeWatch = null;
		this.stopCanvasOverrideWatch = null;
		this.stepAside.cancel();
		liveNoteZoomControls.delete(this);
		this.element.remove();
	}
}

export function ensureNoteZoomControls(
	current: NoteZoomControls | null,
	container: HTMLElement | null,
	parent: () => HTMLElement,
	host: Pick<MobileToolsHost, "noteViewport" | "notePath">
): NoteZoomControls | null {
	return current ?? (container ? new NoteZoomControls(parent(), host) : null);
}

export function destroyNoteZoomControls(current: NoteZoomControls | null): null {
	current?.destroy();
	return null;
}
