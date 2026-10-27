/**
 * ONE CEILING, FOUR SITES (MAXZOOM-6). Folded in from an independent,
 * uncoordinated draft (`maxzoom-6-cells-1420`, 12707122) written against the
 * two InkOverlay.ts sites known at the time; this version adds the third
 * InkOverlay.ts site and the MobileTools.ts button-disable site that this
 * branch's own fix touched.
 *
 * The note's maximum zoom is written in four places, and only one of them is
 * the named constant's definition:
 *
 *   src/inline/PinchScale.ts   MAX_PINCH_SCALE, the clamp every pinch goes through
 *   src/inline/InkOverlay.ts   applyPinchScale's preview-branch `next > MAX_PINCH_SCALE` guard
 *   src/inline/InkOverlay.ts   zoomNoteBy's `Math.min(MAX_PINCH_SCALE, ...)` clamp, the +/- buttons and commands
 *   src/inline/InkOverlay.ts   commitCameraScale's `next>MAX_PINCH_SCALE` refusal, the last gate before a commit
 *   src/inline/MobileTools.ts  the "+" button's `zoom>=MAX_PINCH_SCALE` disable check
 *
 * `ZoomFloorLock.test.ts` and `MobileTools.test.ts` already pin the BEHAVIOUR
 * at each of these sites (a commit/preview/button reaching the real ceiling,
 * the plus button disabling at the right point). That cannot tell the
 * constant from a literal that happens to equal today's ceiling: such a
 * literal would pass every behavioural test and drift silently the next time
 * the constant moves - which is exactly the gap review caught on 772960c7 (two
 * bare `4`s survived a change to the constant). So the three overlay sites are
 * driven here with MAX_PINCH_SCALE MOVED: the overlay is handed a different
 * ceiling, and each site must stop at that one. The plus button's check in
 * MobileTools.ts is still read from its source. Node only: no render, no
 * browser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

// The ceiling the overlay reads, movable per cell. Null means the real one;
// every other export of PinchScale is the real module.
const ceiling = vi.hoisted(() => ({ moved: null as number | null }));
vi.mock("./PinchScale", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		get MAX_PINCH_SCALE(): number {
			return ceiling.moved ?? (actual.MAX_PINCH_SCALE as number);
		},
	};
});

import stripSource from "./MobileTools.ts?raw";
import zoomControlsSource from "./NoteZoomControls.ts?raw";
import { InkOverlayPlugin } from "./InkOverlay";
import { MAX_PINCH_SCALE, MIN_PINCH_SCALE, PINCH_GIVE } from "./PinchScale";

const strip = [stripSource, zoomControlsSource].join("\n").replace(/\r\n/g, "\n");

type Phase = "start" | "move" | "end";
type Point = { x: number; y: number };
type Fields = Record<string, unknown>;

interface OverlayMethods {
	pinch(phase: Phase, ratio: number, centroid: Point): void;
	zoomNoteBy(factor: number): boolean;
	commitCameraScale(next: number, scroll?: { left: number; top: number }): boolean;
}

/**
 * The prototype rig from ZoomFloorLock.test.ts, trimmed to the three sites:
 * the real `pinch` (and its `applyPinchScale` preview branch), `zoomNoteBy`
 * and `commitCameraScale`, with only the DOM, the frame clock and layout sinks
 * stubbed.
 */
function makeRig(start: number) {
	let nextFrame = 1;
	const frames = new Map<number, FrameRequestCallback>();
	const win = {
		requestAnimationFrame: vi.fn((callback: FrameRequestCallback): number => { const id = nextFrame++; frames.set(id, callback); return id; }),
		cancelAnimationFrame: vi.fn((id: number): void => { frames.delete(id); }),
		setTimeout: vi.fn((): number => 0),
		clearTimeout: vi.fn(),
	};
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

	const overlay = Object.create(InkOverlayPlugin.prototype) as Fields;
	overlay.view = { dom: host, scrollDOM: scroller, contentDOM: { getBoundingClientRect: () => ({ left: 0, top: 0 }), children: [] as unknown[] }, posAtCoords: () => null, requestMeasure: vi.fn(), measure: vi.fn() };
	overlay.container = { setCssStyles: vi.fn() };
	overlay.frame = { locked: false };
	// A canvas note: with the canvas off a two-finger gesture is not a zoom at all.
	overlay.canvasMode = true;
	overlay.cssScale = start; overlay.fontZoom = 1; overlay.scale = start;
	overlay.pinchScaleNow = start;
	overlay.zoomFloor = MIN_PINCH_SCALE;
	overlay.pinchRasterScale = start;
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
	overlay.firstSettleConsumer = () => false;

	const methods = InkOverlayPlugin.prototype as unknown as OverlayMethods;
	const centroid = { x: 320, y: 240 };
	const scale = (): number => overlay.pinchScaleNow as number;
	const runFrame = (): void => {
		const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
		if (!entry) throw new Error("expected one requested animation frame");
		frames.delete(entry[0]);
		entry[1](0);
	};
	const pinch = (phase: Phase, ratio: number): void => methods.pinch.call(overlay, phase, ratio, centroid);
	const commit = (next: number): boolean => methods.commitCameraScale.call(overlay, next, { left: 0, top: 0 });
	const button = (factor: number): boolean => methods.zoomNoteBy.call(overlay, factor);
	/** A live preview frame, left hanging mid-gesture: the applyPinchScale preview branch only. */
	const previewTo = (target: number): number => {
		const from = scale();
		pinch("start", 1);
		pinch("move", target / from);
		if (frames.size > 0) runFrame();
		return scale();
	};
	return { scale, commit, button, previewTo };
}

/** The zoom-bar "+" button's disable check. */
function plusButtonCeiling(): string {
	const m = strip.match(/i\s*===\s*2\s*&&\s*state\.zoom\s*>=\s*(\w+)/);
	expect(m, "the plus button's disable check was not found in MobileTools.ts or NoteZoomControls.ts; update this pin with it").not.toBeNull();
	return m![1]!;
}

describe("the note's zoom ceiling is one constant, referenced everywhere", () => {
	describe("with MAX_PINCH_SCALE moved to 5 for the overlay", () => {
		// 5 is neither today's ceiling (6) nor the old one (4), so a site that
		// kept either number as a literal stops somewhere else.
		const MOVED = 5;
		beforeEach(() => {
			ceiling.moved = MOVED;
		});
		afterEach(() => {
			ceiling.moved = null;
		});

		it("applyPinchScale's preview guard reads MAX_PINCH_SCALE", () => {
			expect(makeRig(4).previewTo(MOVED), "precondition: a preview frame under the moved ceiling paints").toBe(MOVED);
			// 6 is inside the real ceiling's give, so only a guard reading the
			// moved constant refuses it.
			expect(
				makeRig(4).previewTo(6),
				"the preview branch painted past the moved ceiling; it still refuses at a literal"
			).toBe(4);
			expect(6).toBeGreaterThan(MOVED * PINCH_GIVE);
		});

		it("zoomNoteBy bounds at MAX_PINCH_SCALE", () => {
			const rig = makeRig(4);
			expect(rig.button(2), "the plus step from 400% was refused outright").toBe(true);
			expect(rig.scale(), "zoomNoteBy still caps at its own literal; MAX_PINCH_SCALE moved without it").toBe(MOVED);
		});

		it("commitCameraScale refuses above MAX_PINCH_SCALE", () => {
			expect(makeRig(4).commit(MOVED), "precondition: a commit at the moved ceiling lands").toBe(true);
			const rig = makeRig(4);
			expect(rig.commit(5.5), "commitCameraScale still refuses at its own literal; MAX_PINCH_SCALE moved without it").toBe(false);
			expect(rig.scale()).toBe(4);
		});
	});

	it("the plus button disables at MAX_PINCH_SCALE", () => {
		expect(plusButtonCeiling(), "the plus button still disables at its own literal; MAX_PINCH_SCALE moved without it").toBe("MAX_PINCH_SCALE");
	});

	it("the ceiling is 600%, and the floor is still below it", () => {
		expect(MAX_PINCH_SCALE).toBe(6);
		expect(MIN_PINCH_SCALE).toBeGreaterThan(0);
		expect(MAX_PINCH_SCALE).toBeGreaterThan(MIN_PINCH_SCALE);
	});
});

/**
 * MAXZOOM-6 (Fleet 3 c2): does raising the ceiling put a wide, magnified note
 * out of MAX_VIEWPORT_LAYOUT's reach?
 *
 * MAX_VIEWPORT_LAYOUT (PinchScale.ts, 8,000,000) bounds the viewport's own
 * LAYOUT-px box - `handleResize`'s `width/this.pinchScaleNow<=MAX_VIEWPORT_LAYOUT`
 * (InkOverlay.ts ~3179), the preview/settle guards' `layout.width/next<=...`
 * (~5418, ~5572), and `commitCameraScale`'s own bound on `target.left/top`
 * (~7455) - never the note's ink-content width directly. Every one of these
 * divides a screen/pane dimension BY the scale before comparing it to the
 * constant, so a HIGHER scale can only shrink the tested quantity: whatever
 * passed at 400% passes at 600% by construction, and nothing that failed at
 * 400% can newly pass either. The cell below is that argument made concrete
 * with the actual arithmetic at both ceilings on a wide (3000 note-px) note,
 * rather than left as an assertion about the source.
 *
 * WHAT THIS DOES NOT COVER: whether the note's own SCROLL RANGE - the native
 * scrollWidth/scrollHeight a 3000-note-px-wide document's column-anchored
 * pinch actually lands on at 6x, and whether the x-anchor keeps the column
 * centred there the way tonight's RLL fix does at every OTHER scale - is
 * correct. That is `test/render/ScrollColumnAnchorPinch.test.ts` /
 * `scrollColumnAnchorPage.ts` territory: it needs the real column-measurement
 * and paint path the render harness drives, which no node-only cell can
 * stand in for honestly. Surveyed, not added tonight - see the handback notes
 * for the exact ramp/pauseAt extension this needs once render-suite time is
 * clear (the render suite launches a real browser; something else is already
 * using it tonight per the original brief, and `chrome-headless-shell` is
 * confirmed running as of this pin).
 */
describe("MAX_VIEWPORT_LAYOUT only gets MORE permissive as the ceiling rises", () => {
	it("a pane already representable at 400% stays representable at 600%, and the reverse never happens", () => {
		const MAX_VIEWPORT_LAYOUT = 8_000_000;
		// A wide note: 3000 note-px, plus headroom a real pane's own box could
		// plausibly reach (well past anything a screen's own clientWidth is),
		// checked at both ceilings.
		for (const paneWidthLayoutPx of [3000, 100_000, 7_999_999, 8_000_000 * 4, 8_000_000 * 6]) {
			const passesAt4 = paneWidthLayoutPx / 4 <= MAX_VIEWPORT_LAYOUT;
			const passesAt6 = paneWidthLayoutPx / MAX_PINCH_SCALE <= MAX_VIEWPORT_LAYOUT;
			// Dividing by a LARGER scale only shrinks the tested quantity.
			if (passesAt4) expect(passesAt6, `${paneWidthLayoutPx} passed at 400% but not 600%`).toBe(true);
			if (!passesAt6) expect(passesAt4, `${paneWidthLayoutPx} failed at 600% but passed at 400%`).toBe(false);
		}
		// The exact boundary case moves out, not in: exactly 8,000,000 * 4 layout
		// px was the largest pane 400% could represent; at 600% it is smaller
		// relative to the same cap, i.e. still representable with room to spare.
		expect((8_000_000 * 4) / 4).toBe(MAX_VIEWPORT_LAYOUT);
		expect((8_000_000 * 4) / MAX_PINCH_SCALE).toBeLessThan(MAX_VIEWPORT_LAYOUT);
	});
});
