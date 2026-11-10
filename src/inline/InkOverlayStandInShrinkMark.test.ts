/**
 * The whole committed paint and a stand-in shrunk under it, held by behaviour.
 *
 * A whole paint reads the stand-in's mark first: the mark says the layers already hold that stand-in's last whole
 * copy at this camera, so a queued frame with nothing changed paints nothing. The same paint may arm the extent
 * build, and an arm may shrink the stand-in (shrinkStandIn), which replaces it with a smaller picture. The layers
 * then hold a copy of the old picture, and the mark read before the arm is the old one's. Kept, it would hand that
 * mark to the shrunk stand-in and paint nothing: the pane would show the old copy while the zoom preview shows the
 * shrunk picture. This file runs the real `paintCommittedWork` on a stand-in overlay whose every other step is a
 * stub and asserts that a shrink at the arm makes the paint copy the shrunk stand-in, and that a paint whose arm
 * leaves the stand-in alone still keeps it.
 */
import { describe, expect, it } from "vitest";

import { InkOverlayPlugin } from "./InkOverlay";
import { SelectionModel } from "../objects/SelectionModel";

/** The overlay's whole paint in a queued frame, with a stand-in whose mark holds, and an arm that shrinks it or not. */
function wholePaintWithStandIn(shrinks: boolean) {
	const proto = Object.create(InkOverlayPlugin.prototype) as object;
	// Own data properties, so a getter on the prototype is replaced rather than assigned through.
	const o = new Proxy(proto, {
		set(target, key, value) {
			Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
			return true;
		},
	}) as Record<string, unknown>;
	const held = { pen: {}, hl: null, at: { x: 0, y: 0, zoom: 1 }, backing: 1, mark: { stamp: "held" } };
	const copied: unknown[] = [];
	o.selection = new SelectionModel();
	o.filePath = () => null;
	o.committedBacking = 1;
	o.dpr = 1;
	o.extentMayBuild = true;
	o.extentArmAsked = false;
	o.highlightPairDeferred = false;
	o.markCommittedPaint = () => undefined;
	o.usableExtent = () => null;
	o.standIn = held;
	o.extentBuild = null;
	o.armExtentBuild = () => {
		o.extentBuild = {};
		if (shrinks) o.standIn = { ...held, pen: {}, backing: 0.5, mark: null };
	};
	o.dropStandIn = () => { o.standIn = null; };
	o.retryStandInLater = () => undefined;
	o.usableStandIn = () => o.standIn;
	o.inQueuedFrame = true;
	// The camera, backing, size and stroke set are those of the held stand-in's last copy.
	o.standInMarkHolds = () => true;
	o.copyFromStandIn = (stand: unknown) => { copied.push(stand); return true; };
	o.committedCtx = new Proxy({}, { get: () => () => undefined });
	o.heldRaster = null;
	return { overlay: o as unknown as InkOverlayPlugin, held, copied, now: () => o.standIn as typeof held | null };
}

describe("a whole paint whose arm shrinks the stand-in copies the shrunk one", () => {
	it("copies the shrunk stand-in once, not keeping the old one's mark", () => {
		const { overlay, held, copied, now } = wholePaintWithStandIn(true);
		overlay.paintCommittedWork({ x: 0, y: 0, zoom: 1 }, "all", []);
		const shrunk = now();
		expect(shrunk, "the arm replaced the stand-in").not.toBe(held);
		expect(copied, "the shrunk stand-in copied once").toEqual([shrunk]);
		expect(shrunk?.mark ?? null, "the old stand-in's mark not handed on").not.toBe(held.mark);
	});

	it("keeps the stand-in and copies nothing when the arm leaves it alone", () => {
		const { overlay, held, copied, now } = wholePaintWithStandIn(false);
		overlay.paintCommittedWork({ x: 0, y: 0, zoom: 1 }, "all", []);
		expect(now(), "the same stand-in").toBe(held);
		expect(copied, "nothing copied").toEqual([]);
		expect(held.mark, "its mark kept").toEqual({ stamp: "held" });
	});
});
