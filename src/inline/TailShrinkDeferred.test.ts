/**
 * An insert space release shrinks the tail backing after its own task, not inside it.
 *
 * The release frame used to shrink the tail from the whole band to the empty backing, a canvas reallocation of 3.8 to 4.4 ms on
 * the test rig. The shrink now waits for a frame and then a timeout. This case pins that order (nothing in the handler, nothing
 * in the next frame, one shrink in the timeout after it) and the skip while a stroke is live. It drives the REAL
 * redrawSelectionUI, queueTailShrink and shrinkTailNow off the prototype with a captured requestAnimationFrame and setTimeout
 * and a counting tail.
 */
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";

function rig() {
	const frames: (() => void)[] = [], timeouts: (() => void)[] = [];
	const shrinks: unknown[][] = [];
	const tail = {
		inlineGrid: { grid: 8, mode: "full" as "full" | "compact" | "empty" },
		restoreFullSurface: () => undefined,
		clearAll: () => undefined,
		prepareLive(...a: unknown[]) { shrinks.push(a); tail.inlineGrid.mode = "empty"; },
	};
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	Object.assign(overlay, {
		tail, container: {}, builder: null, spacePreview: null, spacePlan: null, spaceRowsCache: null,
		lassoActive: false, lassoPts: [], dragBox: null, selection: { size: 0, bounds: () => null },
		strokesHere: () => [], view: { state: EditorState.create({ doc: "" }) },
		cssWidth: 800, cssHeight: 600, cssScale: 1, camera: { snapshot: { x: 0, y: 0, zoom: 1 } },
	});
	// winRef is a getter on the prototype; an own property stands in for the window.
	Object.defineProperty(overlay, "winRef", { value: {
		requestAnimationFrame: (cb: () => void) => { frames.push(cb); return frames.length; },
		setTimeout: (cb: () => void) => { timeouts.push(cb); return timeouts.length; },
	} });
	return {
		overlay, tail, shrinks,
		frame() { for (const cb of frames.splice(0)) cb(); },
		timeout() { for (const cb of timeouts.splice(0)) cb(); },
	};
}

describe("insert space release: the tail shrink waits for a later task", () => {
	it("the redraw that drops the chrome queues the shrink; it runs after a frame and then a timeout, not in the handler", () => {
		const r = rig();
		// The release's redraw: no preview, no lasso, no selection, no live stroke, the tail still at its full size.
		r.overlay.redrawSelectionUI();
		expect(r.shrinks, "no shrink inside the release handler").toEqual([]);
		r.frame();
		expect(r.shrinks, "no shrink in the next frame either").toEqual([]);
		r.timeout();
		expect(r.shrinks, "one shrink to the empty backing in the task after the frame").toEqual([[null, null]]);
		expect(r.tail.inlineGrid.mode).toBe("empty");
	});

	it("a pen down before the task keeps the tail full: the queued shrink skips, and the next release queues again", () => {
		const r = rig();
		r.overlay.redrawSelectionUI();
		r.frame();
		r.overlay.builder = {};
		r.timeout();
		expect(r.shrinks, "skipped while a stroke is live").toEqual([]);
		r.overlay.builder = null;
		r.overlay.redrawSelectionUI();
		r.frame(); r.timeout();
		expect(r.shrinks, "the next redraw without chrome shrinks once").toEqual([[null, null]]);
	});
});
