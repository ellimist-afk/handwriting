/**
 * A lift's one request to rebuild the zoomed-out raster (the lasso and insert space lifts here; the erase lift asks the same
 * one on the eraser lane) is taken by the next committed paint whether or not that paint may build. A pen put down within a
 * frame of the lift makes that paint one that may not build, so the request is spent with no build armed, and no later
 * partial paint asks again.
 *
 * Runs the real paintCommittedWork on a stand-in overlay whose every other step is a no-op, with no damage rects.
 */
import { describe, expect, it } from "vitest";

import { InkOverlayPlugin } from "./InkOverlay";

function overlay() {
	const proto = Object.create(InkOverlayPlugin.prototype) as object;
	const o = new Proxy(proto, {
		set(target, key, value) {
			Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
			return true;
		},
	}) as Record<string, unknown>;
	const armed: number[] = [];
	o.committedBacking = 1;
	o.dpr = 1;
	o.extentMayBuild = false;
	o.extentArmAsked = false;
	o.usableExtent = () => null;
	o.armExtentBuild = () => armed.push(1);
	o.committedCtx = {};
	return { o, armed, plugin: o as unknown as InkOverlayPlugin };
}

const CAM = { x: 0, y: 0, zoom: 0.25 };

describe("a lift's request to rebuild the raster", () => {
	it("control: a paint that may build arms the build the lift asked for", () => {
		const { o, armed, plugin } = overlay();
		o.extentArmAsked = true;
		o.extentMayBuild = true;
		plugin.paintCommittedWork(CAM, [], []);
		expect(armed.length).toBe(1);
	});

	it("survives a first paint that may not build, and the next paint that may build arms it", () => {
		const { o, armed, plugin } = overlay();
		o.extentArmAsked = true;
		// The pen came down within the frame: the queued paint runs with the frame locked.
		o.extentMayBuild = false;
		plugin.paintCommittedWork(CAM, [], []);
		expect(armed.length, "nothing may build in that paint").toBe(0);
		// The next partial paint, after the pen stroke's lift, may build.
		o.extentMayBuild = true;
		plugin.paintCommittedWork(CAM, [], []);
		expect(armed.length, "the lift's request armed a build").toBe(1);
	});
});
