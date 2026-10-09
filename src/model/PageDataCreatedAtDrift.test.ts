import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePage, serializePage } from "./PageData";

/**
 * A MISSING createdAt READS THE SAME ON EVERY LOAD.
 *
 * THIS FILE USED TO PIN BEHAVIOUR THAT WAS WRONG, and it says so because a
 * reader three weeks from now may find an old createdAt ordering argument that
 * leans on it. `migratePageData` read a stroke's creation time as
 *
 *     createdAt: num(s.createdAt) ?? Date.now(),
 *
 * so a stroke whose `createdAt` was absent or unreadable was stamped with the
 * time of THE LOAD: the same bytes gave a different model on every load, and
 * two devices opening one synced file disagreed about when its ink was drawn.
 * The fallback is now a fixed 0. It is wrong the same way on
 * every load, which is the property that matters here: a comparison built on
 * it compares like with like.
 *
 * WHAT STAYS TRUE: a `createdAt` ordering over strokes that reached the
 * fallback says nothing about when they were drawn, before and after the fix.
 * Check this file before trusting one. Nothing outside tests orders or draws by
 * the field.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT ASSERT. It does not claim the parser
 * should raise `damaged`. An ABSENT `createdAt` is indistinguishable from a
 * sidecar written before the field existed, and nothing in the format records
 * which fields a file was written with - `schemaVersion` is per FILE, not per
 * field. Calling absence damage would flag ordinary old files.
 *
 * The two cases that were `it.fails` are plain cases now. The characterisation
 * cases that quoted the clock-stamped value are re-pinned to 0.
 */

const PAGE_ID = "createdat-nondeterminism";
const T1 = 1_000_000_000_000;
const T2 = 2_000_000_000_000;

/** A sidecar whose one stroke carries no `createdAt` at all. */
function sidecarWithout(): string {
	return JSON.stringify({
		schemaVersion: 1,
		pageId: PAGE_ID,
		surface: "inline",
		textBoxes: [],
		images: [],
		strokes: [
			{ id: "s1", tool: "pen", color: "#4b7bec", width: 2, pts: [10, 20, 0.5, 0, 30, 40, 0.5, 8] },
		],
	});
}

/** The same sidecar with a real `createdAt`, as the plugin itself writes it. */
function sidecarWith(createdAt: number): string {
	const raw = JSON.parse(sidecarWithout()) as { strokes: Record<string, unknown>[] };
	raw.strokes[0]!.createdAt = createdAt;
	return JSON.stringify(raw);
}

/** Parse `text` with the clock frozen at `now`. */
function parseAt(now: number, text: string) {
	vi.setSystemTime(now);
	return parsePage(text, PAGE_ID);
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("a stroke with no createdAt reads the fixed fallback, not the time of the load", () => {
	// The setup proof, green and first: the cases below rest on the clock being
	// frozen, one stroke loading and a real createdAt being kept exactly. Break
	// any of this and these go red.
	it("the harness holds: the clock is frozen, one stroke loads, and a REAL createdAt is kept exactly", () => {
		const kept = parseAt(T1, sidecarWith(12345));
		expect(kept.data.strokes).toHaveLength(1);
		// The control that matters: the default fires ONLY when the field is
		// unusable. A file that carries its own time is untouched by any of this.
		expect(kept.data.strokes[0]!.createdAt).toBe(12345);
		expect(kept.damaged).toBeFalsy();

		// And with the field absent, the value is the fixed fallback - not the
		// clock, not the file.
		expect(parseAt(T1, sidecarWithout()).data.strokes[0]!.createdAt).toBe(0);
		expect(parseAt(T2, sidecarWithout()).data.strokes[0]!.createdAt).toBe(0);
	});

	// WHAT IT PRODUCES NOW, received values quoted.
	it("is deterministic: identical bytes, two loads at two clocks, one model", () => {
		const bytes = sidecarWithout();
		const first = parseAt(T1, bytes).data.strokes[0]!.createdAt;
		const second = parseAt(T2, bytes).data.strokes[0]!.createdAt;

		expect(first).toBe(0);
		expect(second).toBe(0);
		// The file still loads clean: nothing warns, and none should.
		expect(parseAt(T1, bytes).damaged).toBeFalsy();
	});

	// The consequence that mattered: two devices that open the same synced file
	// and save it now write the SAME bytes.
	it("re-serialising the same file twice gives the same bytes, each with createdAt 0", () => {
		const bytes = sidecarWithout();
		const outA = serializePage(parseAt(T1, bytes).data);
		const outB = serializePage(parseAt(T2, bytes).data);
		expect(outA).toBe(outB);
		expect(outA).toContain('"createdAt":0');
	});

	it("the same bytes parse to the same model however far apart the loads are", () => {
		const bytes = sidecarWithout();
		expect(parseAt(T2, bytes).data.strokes[0]!.createdAt).toBe(
			parseAt(T1, bytes).data.strokes[0]!.createdAt
		);
	});

	it("loading and re-saving one file twice produces identical bytes", () => {
		const bytes = sidecarWithout();
		expect(serializePage(parseAt(T2, bytes).data)).toBe(serializePage(parseAt(T1, bytes).data));
	});
});
