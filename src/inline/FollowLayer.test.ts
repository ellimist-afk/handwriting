/**
 * Scroll-follow: the ink layer must move with the text between repaints.
 *
 * The defect these pin (v0.13.5 through 358dfaa): the architecture existed
 * but nothing ever wrote a transform. `layerShifted` was assigned false in
 * three places and true in none, so the repaint-time reset was dead code and
 * the canvases sat at their old screen position until the next main-thread
 * repaint, then snapped.
 *
 * These drive the real cycle a scroll produces (scroll, scroll, repaint,
 * scroll) against the real FollowLayer and the real StrokeFrame, asserting
 * the transform actually written to the layer. InkOverlay itself cannot be
 * instantiated in this suite: it is a CodeMirror ViewPlugin needing a live
 * EditorView, canvas 2D contexts, ResizeObserver and matchMedia, and the
 * suite runs in node with no DOM. So the behaviour lives in FollowLayer,
 * DOM-free by construction, exactly as GuardStyle.ts is, and InkOverlay
 * holds one and delegates.
 */

import { describe, expect, it } from "vitest";

import { FollowLayer, NO_SHIFT } from "./FollowLayer";
import { StrokeFrame } from "./StrokeFrame";
import { Camera } from "../camera/Camera";
import { InkStroke } from "../ink/Stroke";

/** Stands in for `.handwriting-ink-layer`: the transform is all that is touched. */
function fakeLayer(): {
	style: { transform: string };
	setCssStyles(styles: { transform: string }): void;
} {
	let transform = "";
	return {
		style: {
			get transform() {
				return transform;
			},
			set transform(value: string) {
				transform = value;
			},
		},
		setCssStyles(styles) {
			transform = styles.transform;
		},
	};
}

/** A scroller whose offsets the test moves, as a real one would. */
function scroller(left = 0, top = 0): { scrollLeft: number; scrollTop: number } {
	return { scrollLeft: left, scrollTop: top };
}

const UNLOCKED = false;

describe("scroll-follow: the ink layer tracks the text between repaints", () => {
	it("scrolling DOWN moves the layer up by exactly the scroll delta", () => {
		const layer = fakeLayer();
		const el = scroller(0, 0);
		const follow = new FollowLayer();
		follow.rebase(layer, el.scrollLeft, el.scrollTop, UNLOCKED); // baseline at rest

		el.scrollTop = 120; // the text moved up 120 layout px
		follow.follow(layer, el.scrollLeft, el.scrollTop, UNLOCKED);

		// The ink has to move up with it: negative Y, same magnitude.
		expect(layer.style.transform).toBe("translate(0px, -120px)");
		expect(follow.shifted).toBe(true);
	});

	it("scrolling RIGHT moves the layer left by exactly the scroll delta", () => {
		const layer = fakeLayer();
		const el = scroller(0, 0);
		const follow = new FollowLayer();
		follow.rebase(layer, el.scrollLeft, el.scrollTop, UNLOCKED);

		el.scrollLeft = 64;
		follow.follow(layer, el.scrollLeft, el.scrollTop, UNLOCKED);

		expect(layer.style.transform).toBe("translate(-64px, 0px)");
		expect(follow.shifted).toBe(true);
	});

	it("keeps fractional scroll offsets instead of rounding them", () => {
		// Fractional offsets are ordinary at fractional zoom, and rounding
		// here reads as ink jitter against the text.
		const layer = fakeLayer();
		const el = scroller(0, 0);
		const follow = new FollowLayer();
		follow.rebase(layer, el.scrollLeft, el.scrollTop, UNLOCKED);

		el.scrollLeft = 10.5;
		el.scrollTop = 33.25;
		follow.follow(layer, el.scrollLeft, el.scrollTop, UNLOCKED);

		expect(layer.style.transform).toBe("translate(-10.5px, -33.25px)");
	});

	it("the delta is layout px and is never scaled by zoom or dpr", () => {
		// The layer sits INSIDE whatever visual transform the editor carries,
		// so the browser applies that scaling to this translate. Multiplying
		// here would double-apply it. A 100 px scroll is 100 px, whatever
		// cssScale, fontZoom, devicePixelRatio or camera.zoom happen to be.
		const layer = fakeLayer();
		const follow = new FollowLayer();
		follow.rebase(layer, 0, 0, UNLOCKED);

		follow.follow(layer, 0, 100, UNLOCKED);

		expect(layer.style.transform).toBe("translate(0px, -100px)");
	});

	it("a repaint takes the new baseline and returns the transform to zero", () => {
		const layer = fakeLayer();
		const el = scroller(0, 0);
		const follow = new FollowLayer();
		follow.rebase(layer, el.scrollLeft, el.scrollTop, UNLOCKED);

		el.scrollTop = 200;
		follow.follow(layer, el.scrollLeft, el.scrollTop, UNLOCKED);
		expect(follow.shifted).toBe(true);

		// repaint(): committed ink is redrawn at the current camera, then the
		// boundary runs in the same frame.
		follow.rebase(layer, el.scrollLeft, el.scrollTop, UNLOCKED);

		expect(layer.style.transform).toBe(NO_SHIFT);
		expect(follow.shifted).toBe(false);
		expect(follow.baseline).toEqual({ left: 0, top: 200 });
	});

	it("a second scroll is measured from the NEW baseline, not the old one", () => {
		const layer = fakeLayer();
		const el = scroller(0, 0);
		const follow = new FollowLayer();
		follow.rebase(layer, el.scrollLeft, el.scrollTop, UNLOCKED);

		el.scrollTop = 200;
		follow.follow(layer, el.scrollLeft, el.scrollTop, UNLOCKED);
		follow.rebase(layer, el.scrollLeft, el.scrollTop, UNLOCKED); // repaint lands

		el.scrollTop = 260;
		follow.follow(layer, el.scrollLeft, el.scrollTop, UNLOCKED);

		// 60 further, not 260 from the original rest position.
		expect(layer.style.transform).toBe("translate(0px, -60px)");
	});

	it("scrolling back to the baseline leaves no shift", () => {
		const layer = fakeLayer();
		const follow = new FollowLayer();
		follow.rebase(layer, 0, 0, UNLOCKED);

		follow.follow(layer, 0, 40, UNLOCKED);
		expect(follow.shifted).toBe(true);
		follow.follow(layer, 0, 0, UNLOCKED); // scrolled back

		expect(layer.style.transform).toBe(NO_SHIFT);
		expect(follow.shifted).toBe(false);
	});

	it("NOTHING translates while a pen stroke owns the frame", () => {
		// The stroke froze its camera at pen-down and every sample maps
		// through it. Shifting the layer under a live stroke would shear it.
		const layer = fakeLayer();
		const follow = new FollowLayer();
		const frame = new StrokeFrame();
		follow.rebase(layer, 0, 0, UNLOCKED);
		layer.setCssStyles({ transform: NO_SHIFT });

		frame.begin(); // pen-down
		follow.follow(layer, 0, 300, frame.locked);

		expect(layer.style.transform).toBe(NO_SHIFT);
		expect(follow.shifted).toBe(false);
		// The baseline is frozen too: the repaint boundary is skipped while
		// locked, so a mid-stroke repaint cannot move it either.
		follow.rebase(layer, 0, 300, frame.locked);
		expect(follow.baseline).toEqual({ left: 0, top: 0 });

		frame.end(); // pen-up: the frame is live again
		follow.follow(layer, 0, 300, frame.locked);
		expect(layer.style.transform).toBe("translate(0px, -300px)");
	});

	it("pen-down during a shifted frame reconciles BEFORE the frame locks", () => {
		// InkOverlay.penDown order: frame.end, syncCamera,
		// reconcileFollowLayer, refreshRect, frame.begin. The reconcile
		// redraws committed ink at the just-synced camera and zeroes the
		// translate, so the frame the stroke locks is internally consistent:
		// fresh ink at the new camera must never be drawn into a layer still
		// carrying the old delta.
		const layer = fakeLayer();
		const follow = new FollowLayer();
		const frame = new StrokeFrame();
		const order: string[] = [];
		follow.rebase(layer, 0, 0, UNLOCKED);

		// A scroll happens; its repaint has not run yet.
		follow.follow(layer, 0, 150, frame.locked);
		expect(follow.shifted).toBe(true);
		expect(layer.style.transform).toBe("translate(0px, -150px)");

		// The pen lands inside that follow interval.
		frame.end();
		order.push("syncCamera");
		if (follow.shifted) {
			order.push("redrawCommitted@currentCamera");
			follow.rebase(layer, 0, 150, frame.locked); // the reconcile
		}
		order.push("refreshRect");
		frame.begin();
		order.push("frame.begin");

		// Zeroed, and zeroed while still unlocked.
		expect(layer.style.transform).toBe(NO_SHIFT);
		expect(follow.shifted).toBe(false);
		expect(follow.baseline).toEqual({ left: 0, top: 150 });
		expect(order).toEqual([
			"syncCamera",
			"redrawCommitted@currentCamera",
			"refreshRect",
			"frame.begin",
		]);

		// And the now-locked frame stays put through further scrolling.
		follow.follow(layer, 0, 400, frame.locked);
		expect(layer.style.transform).toBe(NO_SHIFT);
	});

	it("never touches stored stroke coordinates or camera state", () => {
		// Scroll-follow is presentation only. It moves pixels between
		// repaints and has no route to the model: the coordinates on disk and
		// the camera that maps them are identical across a whole cycle.
		const layer = fakeLayer();
		const follow = new FollowLayer();
		const camera = new Camera();
		camera.setState(12, 34, 1.25);
		const before = { ...camera.snapshot };

		const stroke: InkStroke = {
			id: "s1",
			tool: "pen",
			color: "#4b7bec",
			width: 2.2,
			points: [
				{ x: 5, y: 7, pressure: 0.5, t: 0 },
				{ x: 9, y: 11, pressure: 0.5, t: 8 },
			],
			bbox: { x: 5, y: 7, width: 4, height: 4 },
			createdAt: 0,
		};
		const strokeBefore = JSON.stringify(stroke);

		follow.rebase(layer, 0, 0, UNLOCKED);
		follow.follow(layer, 30, 120, UNLOCKED);
		follow.rebase(layer, 30, 120, UNLOCKED);
		follow.follow(layer, 30, 500, UNLOCKED);

		expect(camera.snapshot).toEqual(before);
		expect(JSON.stringify(stroke)).toBe(strokeBefore);
		// The layer moved, so the cycle really ran.
		expect(layer.style.transform).toBe("translate(0px, -380px)");
	});

	it("forget() drops the shift when the layer goes away", () => {
		const layer = fakeLayer();
		const follow = new FollowLayer();
		follow.rebase(layer, 0, 0, UNLOCKED);
		follow.follow(layer, 0, 90, UNLOCKED);
		expect(follow.shifted).toBe(true);

		follow.forget(); // unmount / file switch

		expect(follow.shifted).toBe(false);
	});

	it("a null layer is inert but still tracks state", () => {
		// unmount races a scroll event: no element to write, no throw.
		const follow = new FollowLayer();
		follow.rebase(null, 0, 0, UNLOCKED);
		expect(() => follow.follow(null, 0, 50, UNLOCKED)).not.toThrow();
		expect(follow.shifted).toBe(true);
	});
});
