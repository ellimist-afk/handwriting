import { describe, expect, it } from "vitest";
import { PageStore } from "./persistence/PageStore";
import { FakeAdapter } from "./persistence/FakeAdapter";
import { emptyPage, serializePage } from "./model/PageData";
import type { InkStroke } from "./ink/Stroke";

/**
 * `recovered` CARRIES FOUR EVENTS AND ITS ONE READER ASSUMES ONE OF THEM.
 *
 * This is the same disease as `damaged`, one field over, found by auditing the
 * flag the way `damaged` was audited. Constructions, not reads:
 *
 *   A  parse failed / read threw   `emptyPage`, and always `damaged: true`
 *                                  (`PageData.ts:876`, `PageStore.ts:996`)
 *   B  interrupted save promoted   a real page, parse SUCCEEDED
 *                                  (`PageStore.ts:990`)
 *   C  ink found in the trash      a real page - restored (`:1129`), or the
 *                                  restore FAILED and it is still in the
 *                                  trash (`:1118`)
 *   D  main file unreadable, the   a real page, plus `damagedKeptAs`
 *      interrupted save promoted   (`PageStore.ts:1235`)
 *
 * THE ONE READER was the canvas page view's recovery branch -
 * `else if (result?.recovered && !result.damagedKeptAs)` - which said
 * "Handwriting recovered this note's ink from an interrupted save. Nothing was
 * lost." It excluded A (the earlier `damaged` branch took it) and D (by
 * `damagedKeptAs`). **It did not exclude C**, so a trash restore was announced
 * as an interrupted save. That reader was deleted with the view, and
 * no surface reads `recovered` this way today - which removes the live defect
 * and leaves the field exactly as ambiguous as it was for the next one.
 * The identical failure as `PdfInkStore.ts:205` and `SlidesInkSurface.ts:2275`,
 * which still assert that `damaged` means placeholder.
 *
 * WHAT THIS FILE PINS is the SHAPE, not the flag: that a page whose ink came
 * back from the trash arrives carrying the same three field values the
 * interrupted-save case carries, so no reader can tell them apart. It does not
 * propose that anything key off `recovered` - deciding what the distinction
 * should be called belongs to whoever holds `PageData.ts`.
 *
 * A CHARACTERISATION FILE. It pins behaviour that is WRONG; a fix will redden
 * the case named "takes the interrupted-save branch", and that is the design.
 */

const PAGE_ID = "recovered-shapes";
const HOME = ".handwriting";

/** `restoreFromTrash` needs an adapter that can enumerate; FakeAdapter cannot. */
class ListingAdapter extends FakeAdapter {
	async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = dir.endsWith("/") ? dir : dir + "/";
		const files = [...this.files.keys()].filter((p) => p.startsWith(prefix));
		if (files.length === 0 && !this.dirs.has(dir)) throw new Error("no such folder: " + dir);
		return { files, folders: [] };
	}
}

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2,
		createdAt: 1,
		points: [
			{ x: 10, y: 20, pressure: 0.5, t: 0 },
			{ x: 30, y: 40, pressure: 0.5, t: 8 },
		],
		bbox: { x: 10, y: 20, width: 20, height: 20 },
	};
}

function sidecarText(): string {
	const page = emptyPage(PAGE_ID);
	page.surface = "inline";
	page.strokes.push(stroke("s0"));
	return serializePage(page);
}

describe("a page recovered from the trash is indistinguishable from an interrupted save", () => {
	/** No live sidecar; one readable generation sitting in the folder's trash. */
	function withTrashOnly() {
		const adapter = new ListingAdapter();
		adapter.externalWrite(`${HOME}/trash/${PAGE_ID}-1.json`, sidecarText());
		return { adapter, store: new PageStore({ vault: { adapter } }) };
	}

	// The harness proof, first and green: the trash generation is found, the
	// ink comes back, and the parse genuinely succeeded. Without this the
	// assertions below could be measuring a load that failed for another reason.
	it("the harness holds: the ink comes back from the trash as a real page", async () => {
		const { store } = withTrashOnly();
		const result = await store.load(PAGE_ID);
		expect(result).not.toBeNull();
		expect(result!.data.strokes.map((s) => s.id)).toEqual(["s0"]);
		// Real ink, not a placeholder - so this is one of the shapes where the
		// parse succeeded, unlike the two that carry `damaged`.
		expect(result!.damaged).toBeFalsy();
	});

	// THE DEFECT. The three fields the reader branches on are identical to the
	// interrupted-save case, so the trash restore takes that branch and the
	// user is told their ink came back from an interrupted save.
	it("takes the interrupted-save branch: recovered, no damagedKeptAs, nothing to tell it apart", async () => {
		const { store } = withTrashOnly();
		const result = await store.load(PAGE_ID);

		expect(result!.recovered).toBe(true);
		expect(result!.damagedKeptAs).toBeUndefined();
		// This is the deleted view's recovery condition verbatim: the branch
		// that announced an interrupted save, kept here as the shape a future
		// reader would most likely write.
		expect(!!result!.recovered && !result!.damagedKeptAs).toBe(true);

		// And the store DOES know which event happened - it says so in a field
		// nobody branches on.
		expect(result!.problem).toContain("trash");
	});

	// The control: an ordinary live sidecar does not take that branch, so the
	// assertion above is attributable to the trash path and not to every load.
	it("control: an ordinary load is not announced as a recovery at all", async () => {
		const adapter = new ListingAdapter();
		adapter.externalWrite(`${HOME}/${PAGE_ID}.json`, sidecarText());
		const store = new PageStore({ vault: { adapter } });
		const result = await store.load(PAGE_ID);

		expect(result!.data.strokes.map((s) => s.id)).toEqual(["s0"]);
		expect(result!.recovered).toBe(false);
		expect(!!result!.recovered && !result!.damagedKeptAs).toBe(false);
	});

	// And the field's own docstring is stale in the same way the two `damaged`
	// comments are: "True when the sidecar existed but could not be understood"
	// describes only shape A, while this result parsed perfectly.
	it("the docstring describes only the shape this is not", async () => {
		const { store } = withTrashOnly();
		const result = await store.load(PAGE_ID);
		expect(result!.recovered).toBe(true);
		expect(result!.data.strokes.length).toBeGreaterThan(0); // understood fine
	});
});
