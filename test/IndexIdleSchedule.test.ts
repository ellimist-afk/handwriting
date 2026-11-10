/**
 * The stroke index's idle rebuild waits while the view is moving, then still runs, held by behaviour on a clock.
 *
 * A fling over a dirty index used to pay the whole rebuild between two of its frames. The idle rebuild now waits until
 * no scroll step was asked for and no paint drew at a moved camera within EXTENT_SCROLL_QUIET_MS. The render cells
 * drive that through scroll steps, so a moving paint alone is never the only reason to wait there. This file runs the
 * real `scheduleIndexIdle` on a stand-in overlay under fake timers and asserts both halves: a moving paint with no
 * scroll ask holds the rebuild back, and once the view is still the rebuild runs exactly once and leaves the index clean.
 *
 * It lives under test/ and not src/ because the build digest walks src/**: a test file added there would change main.js.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { InkOverlayPlugin } from "../src/inline/InkOverlay";
import { EXTENT_SCROLL_QUIET_MS } from "../src/inline/InkOverlayConstants";

/** A stand-in overlay: a dirty index, no scroll ask yet, a window with timers and no idle callback (the iOS path). */
function dirtyOverlay() {
	const proto = Object.create(InkOverlayPlugin.prototype) as object;
	// Own data properties, so a getter on the prototype (the window reference) is replaced rather than assigned through.
	const o = new Proxy(proto, {
		set(target, key, value) {
			Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
			return true;
		},
	}) as Record<string, unknown>;
	const rebuilds: { why: string; at: number }[] = [];
	o.winRef = {
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
		clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
	};
	o.container = {};
	o.indexDirty = true;
	o.indexIdle = null;
	o.lastScrollAskAt = -Infinity;
	o.lastMovingPaintAt = undefined;
	o.filePath = () => "note.md";
	o.noteStrokes = () => [];
	o.committedStrokes = (s: unknown) => s;
	o.rebuildIndex = (_strokes: unknown, why: string) => {
		rebuilds.push({ why, at: performance.now() });
		o.indexDirty = false;
	};
	const schedule = () => (InkOverlayPlugin.prototype as unknown as { scheduleIndexIdle(this: unknown): void }).scheduleIndexIdle.call(o);
	return { o, rebuilds, schedule };
}

describe("stroke index idle rebuild", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("a paint at a moved camera with no scroll ask holds the idle rebuild back, then once still it runs exactly once", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const { o, rebuilds, schedule } = dirtyOverlay();
		const start = performance.now();
		// A paint at a moved camera just now; no scroll step was ever asked for.
		o.lastMovingPaintAt = start;
		schedule();
		// Inside the quiet window: the idle callback has come and gone, and the index is still dirty.
		vi.advanceTimersByTime(EXTENT_SCROLL_QUIET_MS - 1);
		expect({ rebuilds: rebuilds.length, dirty: o.indexDirty }, "no rebuild while a moving paint is inside the quiet window").toEqual({ rebuilds: 0, dirty: true });
		// Well past it, with nothing moving since.
		vi.advanceTimersByTime(10 * EXTENT_SCROLL_QUIET_MS);
		expect({ whys: rebuilds.map((r) => r.why), dirty: o.indexDirty, pending: o.indexIdle },
			"one idle rebuild once the view is still, the index clean and nothing left scheduled").toEqual({ whys: ["idle"], dirty: false, pending: null });
		expect((rebuilds[0]?.at ?? -Infinity) - start,"the rebuild waits out the quiet window from the moving paint").toBeGreaterThanOrEqual(EXTENT_SCROLL_QUIET_MS);
	});
});
