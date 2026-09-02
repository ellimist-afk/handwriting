/**
 * PalmGate is the palm policy shared by both routers (§5l L1: it had never
 * had a test). The header comment states the rules in prose; each describe
 * block below pins one sentence of it. Times are injected performance.now()
 * values so nothing here depends on a clock or a fake timer.
 */

import { describe, expect, it } from "vitest";
import {
	PAROLE_DIST_PX,
	PAROLE_MAX_CONTACT_PX,
	PAROLE_WINDOW_MS,
	PalmGate,
	paroleEarned,
} from "./PalmGate";

describe("paroleEarned - pure motion test", () => {
	it("fast travel inside the window earns parole", () => {
		expect(
			paroleEarned({ travelPx: PAROLE_DIST_PX, sinceDownMs: 50, penStrokeActive: false })
		).toBe(true);
	});

	it("slow drift - travel under the threshold - does not earn parole", () => {
		expect(
			paroleEarned({ travelPx: PAROLE_DIST_PX - 1, sinceDownMs: 50, penStrokeActive: false })
		).toBe(false);
	});

	it("a contact wider than PAROLE_MAX_CONTACT_PX never earns parole, even with fast travel", () => {
		expect(
			paroleEarned({
				travelPx: 100,
				sinceDownMs: 10,
				penStrokeActive: false,
				contactPx: PAROLE_MAX_CONTACT_PX + 1,
			})
		).toBe(false);
	});

	it("a contact exactly at the size veto boundary still gets the motion test", () => {
		expect(
			paroleEarned({
				travelPx: PAROLE_DIST_PX,
				sinceDownMs: 10,
				penStrokeActive: false,
				contactPx: PAROLE_MAX_CONTACT_PX,
			})
		).toBe(true);
	});

	it("the window boundary: sinceDownMs at PAROLE_WINDOW_MS still counts, past it does not", () => {
		expect(
			paroleEarned({ travelPx: PAROLE_DIST_PX, sinceDownMs: PAROLE_WINDOW_MS, penStrokeActive: false })
		).toBe(true);
		expect(
			paroleEarned({ travelPx: PAROLE_DIST_PX, sinceDownMs: PAROLE_WINDOW_MS + 1, penStrokeActive: false })
		).toBe(false);
	});

	it("while writing, everything is palm - no parole even for a swipe-shaped contact", () => {
		expect(
			paroleEarned({ travelPx: 100, sinceDownMs: 10, penStrokeActive: true })
		).toBe(false);
	});

	it("a contact a pen stroke overlapped is that hand for the rest of its life", () => {
		expect(
			paroleEarned({
				travelPx: 100,
				sinceDownMs: 10,
				penStrokeActive: false,
				penContactOverlapped: true,
			})
		).toBe(false);
	});
});

describe("PalmGate.blocksNewTouch - active stroke", () => {
	it("a touch arriving while a pen stroke is active is palm", () => {
		const gate = new PalmGate();
		gate.penStrokeStarted();
		expect(gate.blocksNewTouch(1_000)).toBe(true);
		// Still true much later - an active stroke doesn't time out.
		expect(gate.blocksNewTouch(1_000_000)).toBe(true);
	});
});

describe("PalmGate.blocksNewTouch - release tail after the pen lifts", () => {
	it("stays ignored for the tail, then opens up", () => {
		const gate = new PalmGate();
		gate.penStrokeStarted();
		gate.penStrokeEnded(1_000);
		// Just inside the 250ms tail.
		expect(gate.blocksNewTouch(1_000 + 249)).toBe(true);
		// At and past the tail, with no other reason to block.
		expect(gate.blocksNewTouch(1_000 + 250)).toBe(false);
	});
});

describe("PalmGate.blocksNewTouch - hover tail (palm placed before pen)", () => {
	it("a touch inside the post-hover window is palm", () => {
		const gate = new PalmGate();
		gate.penHoverSeen(2_000);
		expect(gate.blocksNewTouch(2_000 + 299)).toBe(true);
	});

	it("after the window it is not", () => {
		const gate = new PalmGate();
		gate.penHoverSeen(2_000);
		expect(gate.blocksNewTouch(2_000 + 300)).toBe(false);
	});
});

describe("penStrokeEnded lifts the active-stroke block", () => {
	it("isPenStrokeActive flips false immediately, even though the release tail still blocks touch", () => {
		const gate = new PalmGate();
		gate.penStrokeStarted();
		expect(gate.isPenStrokeActive).toBe(true);
		gate.penStrokeEnded(3_000);
		expect(gate.isPenStrokeActive).toBe(false);
		// The active-stroke veto is gone, but the release tail still applies
		// right at the moment of lift.
		expect(gate.blocksNewTouch(3_000)).toBe(true);
		// Once both the release tail and (absent) hover tail have elapsed,
		// the block is fully lifted.
		expect(gate.blocksNewTouch(3_000 + 250)).toBe(false);
	});
});

describe("PalmGate.isPenNear", () => {
	it("true while a stroke is active", () => {
		const gate = new PalmGate();
		gate.penStrokeStarted();
		expect(gate.isPenNear(5_000)).toBe(true);
	});

	it("true within the hover tail, false once it elapses - this is how a side-button menu during hover gets attributed to the pen", () => {
		const gate = new PalmGate();
		gate.penHoverSeen(6_000);
		expect(gate.isPenNear(6_000 + 299)).toBe(true);
		expect(gate.isPenNear(6_000 + 300)).toBe(false);
	});

	it("false with no stroke and no recent hover", () => {
		const gate = new PalmGate();
		expect(gate.isPenNear(7_000)).toBe(false);
	});
});

// NOT testable through PalmGate's public surface: "Touch contacts that began
// BEFORE the pen arrived are handled by the TouchController (it drops its
// gesture when the pen goes active)." That rule lives in TouchController's
// behaviour, not in any PalmGate method - PalmGate only ever sees the
// pen-side state transitions and the query methods above.
