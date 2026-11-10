/**
 * The move-feeds-ink latch is per stroke (battery: the raw listener is bound
 * only while a stroke is in flight, so a stroke's raw may start late). A raw
 * seen in one stroke says nothing about the next one's first milliseconds:
 * moves feed each stroke until that stroke's own first raw.
 */

import { describe, expect, it } from "vitest";
import { InkFeedArbiter } from "./InkFeed";

describe("InkFeedArbiter, per-stroke raw latch", () => {
	it("a raw in one stroke does not silence the next stroke's moves", () => {
		const a = new InkFeedArbiter();
		a.strokeStart(100);
		a.noteRawChannel();
		expect(a.moveFeedsInk()).toBe(false);
		a.strokeEnd();
		a.strokeStart(300);
		expect(a.moveFeedsInk(), "the second stroke starts move-fed").toBe(true);
		expect(a.feed([304, 308])).toEqual([0, 1]);
		a.noteRawChannel();
		expect(a.moveFeedsInk()).toBe(false);
		expect(a.feed([304, 308, 312])).toEqual([2]);
	});

	it("a raw before any stroke (a hover the listener caught) does not silence the stroke's moves", () => {
		const a = new InkFeedArbiter();
		a.noteRawChannel();
		a.strokeStart(100);
		expect(a.moveFeedsInk()).toBe(true);
	});
});
