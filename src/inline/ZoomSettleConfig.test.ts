/**
 * A zoom settle appends the scroll-lifetime extension only when the editor
 * lacks it.
 *
 * Every pinch or wheel zoom lift that settles through a hold issued
 * `appendConfig` of the same extension, and each append makes CodeMirror
 * re-resolve the editor's whole configuration. The first settle must still
 * install it (it carries the cancellation handler); later ones must not.
 *
 * Drives the real `commitCameraScale` settle-hold branch on a prototype rig
 * with a REAL EditorState that the rig's dispatch updates, so what the first
 * settle appended is really in the configuration the second one reads.
 */
import { describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, StateEffect, type TransactionSpec } from "@codemirror/state";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";
import { MIN_PINCH_SCALE } from "./PinchScale";

type Fields = Record<string, unknown>;

function makeRig() {
	const win = { requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn(), setTimeout: vi.fn(() => 0), clearTimeout: vi.fn() };
	const hostStyles: Record<string, string> = {};
	const host = {
		clientWidth: 640, clientHeight: 480,
		ownerDocument: { defaultView: win },
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
		style: {
			getPropertyValue(name: string): string { return hostStyles[name] ?? ""; },
			setProperty(name: string, value: string): void { hostStyles[name] = value; },
			removeProperty(name: string): void { delete hostStyles[name]; },
		},
		setCssStyles(styles: Record<string, string>): void { Object.assign(hostStyles, styles); },
	};
	const scroller = { scrollLeft: 0, scrollTop: 0, scrollWidth: 64000, scrollHeight: 48000, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }) };
	const dispatched: TransactionSpec[] = [];
	const view = {
		dom: host, scrollDOM: scroller,
		contentDOM: { getBoundingClientRect: () => ({ left: 0, top: 0 }), children: [] as unknown[] },
		requestMeasure: vi.fn(), measure: vi.fn(),
		viewport: { from: 0, to: 0 },
		contentHeight: 1000,
		state: EditorState.create({ doc: "one\ntwo\nthree\n" }),
		dispatch(spec: TransactionSpec) { dispatched.push(spec); view.state = view.state.update(spec).state; },
	};
	const overlay = Object.create(InkOverlayPlugin.prototype) as Fields;
	overlay.view = view;
	overlay.container = { setCssStyles: vi.fn() };
	overlay.frame = { locked: false };
	overlay.canvasMode = true;
	overlay.cssScale = 1; overlay.fontZoom = 1; overlay.scale = 1;
	overlay.pinchScaleNow = 1;
	overlay.zoomFloor = MIN_PINCH_SCALE;
	overlay.pinchRasterScale = 1;
	overlay.pinchRefScale = null;
	overlay.pinchStartPan = { x: 0, y: 0 };
	overlay.pinchBand = { history: [] as number[], lastPan: { x: 0, y: 0 } };
	overlay.pinchAnchor = null;
	overlay.pinchPending = null;
	overlay.pinchRaf = 0;
	overlay.pinchScrollAt = 0;
	overlay.pinchHiddenCanvases = new Map();
	overlay.viewportGeneration = 0;
	overlay.retiring = false;
	overlay.panAnchorHold = null;
	overlay.scrollExpansion = null;
	overlay.getNoteViewportState = () => ({ zoom: overlay.pinchScaleNow, busy: false, fitAvailable: true });
	overlay.prepareViewportLayout = () => true;
	overlay.viewportLayout = { width: 640, height: 480, baseTransform: "none" };
	overlay.filePath = () => "note.md";
	overlay.panX = () => 0;
	overlay.panY = () => 0;
	for (const name of ["restorePinchLayers", "retirePanSettle", "releaseMeasures", "clearViewportPan", "updatePaperSpacing", "refreshPenCursor", "updateExtent", "reanchorPan", "scheduleRepaint", "handleResize"]) overlay[name] = vi.fn();
	overlay.applyViewportBox = (next: number) => host.setCssStyles({ transform: `scale(${next})`, transformOrigin: "0 0" });
	overlay.setViewportScroll = (left: number, top: number) => { scroller.scrollLeft = left; scroller.scrollTop = top; };
	overlay.syncBand = () => "none";
	// The settle-hold branch: this commit is the hold's first consumer and
	// the hold names a visible position.
	overlay.firstSettleConsumer = () => true;
	overlay.ownScrollRange = () => EditorSelection.cursor(0);
	overlay.ownsPanSettle = () => true;
	overlay.restingColumnMargin = 0;

	const commit = (next: number) => {
		const hold = { left: 0, top: 0, ready: false, outcome: "pending", attempts: 0, request: null, issuance: [] as unknown[] };
		overlay.panAnchorHold = hold;
		const ok = (InkOverlayPlugin.prototype as unknown as { commitCameraScale(n: number, s: { left: number; top: number }, h: object): boolean })
			.commitCameraScale.call(overlay, next, { left: 0, top: 0 }, hold);
		return { ok, hold };
	};
	return { view, dispatched, commit };
}

const appends = (effects: readonly unknown[]) =>
	effects.filter((e) => (e as StateEffect<unknown>).is(StateEffect.appendConfig)).length;

describe("zoom settle appends the scroll-lifetime extension once", () => {
	it("first settle appends it, the next three do not, and every settle still issues its scroll request", () => {
		const rig = makeRig();
		const counts: number[] = [];
		for (const next of [0.8, 0.6, 0.9, 0.7]) {
			const before = rig.dispatched.length;
			rig.commit(next);
			expect(rig.dispatched.length, `settle to ${next} dispatched once`).toBe(before + 1);
			const effects = [rig.dispatched[rig.dispatched.length - 1]!.effects].flat() as unknown[];
			expect(effects.length, "the scroll request is issued").toBeGreaterThanOrEqual(1);
			counts.push(appends(effects));
		}
		expect(counts, "appendConfig per settle").toEqual([1, 0, 0, 0]);
	});

	it("an editor reconfigured without it gets it back at the next settle", () => {
		const rig = makeRig();
		rig.commit(0.8);
		// A full reconfigure (a theme or plugin change) drops appended config.
		rig.view.state = EditorState.create({ doc: rig.view.state.doc });
		rig.commit(0.6);
		const effects = [rig.dispatched[rig.dispatched.length - 1]!.effects].flat() as unknown[];
		expect(appends(effects)).toBe(1);
	});
});
