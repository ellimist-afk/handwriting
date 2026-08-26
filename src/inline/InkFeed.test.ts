/**
 * The feed decision has to be correct under every event ordering the two
 * engines produce: raw-only strokes (Chromium), move-only strokes (WebKit,
 * where raw never fires), and the one race between them — the session's
 * first cold strike on Chromium, where a flushed move could beat the first
 * raw to the same samples.
 */

import { describe, expect, it } from "vitest";
import { InkFeedArbiter } from "./InkFeed";

describe("InkFeedArbiter", () => {
	it("feeds every raw sample on a raw-only stream (Chromium)", () => {
		const a = new InkFeedArbiter();
		a.noteRawChannel();
		a.strokeStart(100);
		expect(a.feed([104, 108, 112])).toEqual([0, 1, 2]);
		expect(a.feed([116, 120])).toEqual([0, 1]);
		expect(a.moveFeedsInk()).toBe(false);
	});

	it("feeds every move sample when raw never arrives (WebKit)", () => {
		const a = new InkFeedArbiter();
		a.strokeStart(100);
		expect(a.moveFeedsInk()).toBe(true);
		expect(a.feed([104, 106, 108, 110])).toEqual([0, 1, 2, 3]);
		expect(a.feed([112, 114])).toEqual([0, 1]);
		expect(a.moveFeedsInk()).toBe(true);
	});

	it("a hover raw before the stroke silences the move feed", () => {
		const a = new InkFeedArbiter();
		a.noteRawChannel(); // approach hover, before any contact
		a.strokeStart(100);
		expect(a.moveFeedsInk()).toBe(false);
	});

	it("a move flushed ahead of the first raw feeds once, raw duplicates drop", () => {
		const a = new InkFeedArbiter();
		a.strokeStart(100);
		// Cold strike: no raw yet, the frame-aligned move dispatches first.
		expect(a.moveFeedsInk()).toBe(true);
		expect(a.feed([104, 108, 112])).toEqual([0, 1, 2]);
		// The withheld raw flushes the same samples plus one newer.
		a.noteRawChannel();
		expect(a.feed([104, 108, 112, 116])).toEqual([3]);
		// From here the session is raw-fed.
		expect(a.moveFeedsInk()).toBe(false);
	});

	it("hover-tail samples stamped before the down never ink", () => {
		const a = new InkFeedArbiter();
		a.strokeStart(100);
		// WebKit folds approach samples into the first move's list.
		expect(a.feed([92, 96, 100, 104, 108])).toEqual([3, 4]);
	});

	it("the stroke boundary resets the high-water mark", () => {
		const a = new InkFeedArbiter();
		a.strokeStart(100);
		expect(a.feed([104, 108])).toEqual([0, 1]);
		a.strokeEnd();
		// Between strokes nothing feeds, whatever the stamp.
		expect(a.feed([200, 204])).toEqual([]);
		a.strokeStart(300);
		expect(a.feed([304, 308])).toEqual([0, 1]);
	});

	it("overlap between consecutive move lists drops by timestamp", () => {
		const a = new InkFeedArbiter();
		a.strokeStart(100);
		expect(a.feed([104, 108])).toEqual([0, 1]);
		expect(a.feed([108, 112, 116])).toEqual([1, 2]);
	});

	it("quantized equal stamps inside one list all ink", () => {
		const a = new InkFeedArbiter();
		a.strokeStart(100);
		// WebKit's coarsened clock can stamp two real samples identically.
		expect(a.feed([104, 104, 108])).toEqual([0, 1, 2]);
		// Across events the same stamp is a duplicate and drops.
		expect(a.feed([108, 112])).toEqual([1]);
	});
});
