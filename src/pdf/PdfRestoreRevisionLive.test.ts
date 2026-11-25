/**
 * "Fix ink de-sync" restoring a revision while an erase is live on the PDF.
 *
 * A live erase takes its page out of the document list: `live` holds that page's strokes and the positions they
 * held when the gesture began, and `strokes` is stale for that page until the next whole read folds it back.
 * restoreRevision swaps `strokes` for the picked copy and leaves `live` as it was, so the page read goes on
 * serving the replaced copy's page, and the fold puts that page back into the picked copy at the old positions.
 *
 * Bound: after a restore the record holds the picked copy whole. No later fold, read or save brings back a
 * stroke of the replaced copy or drops a picked one. A restore with no gesture live stays as it is.
 *
 * Every want line is soft, so each one is read and reported on its own.
 */

import { describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { PageData, ParseResult, emptyPage } from "../model/PageData";
import { PdfInkHost, PdfInkStore } from "./PdfInkStore";

const DOC = "pdf-restore-live";

function stroke(id: string, page: number): InkStroke {
	const points = [
		{ x: 10, y: 10, pressure: 0.5, t: 0 },
		{ x: 20, y: 20, pressure: 0.5, t: 8 },
	];
	return { id, tool: "pen", color: "#4b7bec", width: 2, points, bbox: computeBBox(points, 4), createdAt: 0, page };
}

function page(strokes: InkStroke[]): PageData {
	return { ...emptyPage(DOC), surface: "pdf", strokes };
}

const ids = (list: readonly InkStroke[]): string[] => list.map((s) => s.id);

/** A loaded record with a host that keeps every save. */
async function loaded(): Promise<{ store: PdfInkStore; saved: PageData[] }> {
	const saved: PageData[] = [];
	const empty: ParseResult = { data: page([]), recovered: false };
	const host: PdfInkHost = {
		load: async (id) => ({ ...empty, data: { ...empty.data, pageId: id } }),
		schedule: (_id, data) => void saved.push(data),
		notice: () => {},
	};
	const store = new PdfInkStore();
	store.attachHost(host);
	await store.ensureLoaded(DOC);
	return { store, saved };
}

/** The eraser takes `a` whole on page 1: page 1 goes live. */
function eraseLive(store: PdfInkStore, a: InkStroke): void {
	store.applyLivePage(DOC, { type: "replace", path: DOC, removed: [a], removedAt: [0], inserted: [], insertedAt: [] });
}

/** Run `act`; the error it threw, or null. */
function thrownBy(act: () => void): unknown {
	try {
		act();
		return null;
	} catch (err) {
		return err;
	}
}

describe("fix ink de-sync restores a revision while an erase is live", () => {
	it("the copies differ at the live page's positions: the page read, a whole read and the next save hold the picked copy whole", async () => {
		const { store, saved } = await loaded();
		const a = stroke("a", 1), x = stroke("x", 2), b = stroke("b", 1), y = stroke("y", 2);
		store.replaceAll(DOC, [a, x, b, y]);
		eraseLive(store, a);
		expect(ids(store.strokesOnPage(DOC, 1)), "premise: the erase is live on page 1").toEqual(["b"]);

		// The other device's copy: different strokes at every position, page 1's at 0 and 2.
		const picked = [stroke("p", 1), stroke("q", 2), stroke("r", 1), stroke("s", 2)];
		expect(store.restoreRevision(DOC, page(picked)), "premise: a loaded record took the picked copy").toBe(true);

		expect.soft(ids(store.strokesOnPage(DOC, 1)), "W1 the page read serves the picked copy's page 1").toEqual(["p", "r"]);
		expect.soft(ids(store.strokesOnPage(DOC, 2)), "W2 the other page reads the picked copy").toEqual(["q", "s"]);
		expect.soft(ids(store.strokes(DOC)), "W3 a whole read holds the picked copy whole").toEqual(["p", "q", "r", "s"]);
		const before = saved.length;
		const thrown = thrownBy(() => store.save(DOC));
		expect.soft(thrown, "W4 the save after the restore does not throw").toBeNull();
		expect.soft(saved.slice(before).map((d) => ids(d.strokes)), "W5 the save writes the picked copy whole").toEqual([["p", "q", "r", "s"]]);
	});

	it("a position past the end of the picked copy: the save does not throw and writes the picked copy, and a read holds it", async () => {
		const { store, saved } = await loaded();
		const a = stroke("a", 1), x = stroke("x", 2), b = stroke("b", 1);
		store.replaceAll(DOC, [a, x, b]);
		eraseLive(store, a);
		expect(ids(store.strokesOnPage(DOC, 1)), "premise: the erase is live on page 1, at positions 0 and 2").toEqual(["b"]);

		// The picked copy is one stroke long, so page 1's second position (2) is past its end.
		const picked = [stroke("p", 1)];
		expect(store.restoreRevision(DOC, page(picked)), "premise: a loaded record took the picked copy").toBe(true);

		expect.soft(ids(store.strokesOnPage(DOC, 1)), "W1 the page read serves the picked copy's page 1").toEqual(["p"]);
		const before = saved.length;
		const thrown = thrownBy(() => store.save(DOC));
		expect.soft(thrown, "W2 the save after the restore does not throw").toBeNull();
		expect.soft(saved.slice(before).map((d) => ids(d.strokes)), "W3 the save writes the picked copy").toEqual([["p"]]);
		expect.soft(ids(store.strokes(DOC)), "W4 a whole read holds the picked copy").toEqual(["p"]);
	});

	it("the eraser's next sample after the restore cuts the picked copy's stroke under the nib, and the save holds the rest whole", async () => {
		const { store, saved } = await loaded();
		const a = stroke("a", 1), x = stroke("x", 2), b = stroke("b", 1), y = stroke("y", 2);
		store.replaceAll(DOC, [a, x, b, y]);
		eraseLive(store, a);
		expect(ids(store.strokesOnPage(DOC, 1)), "premise: the erase is live on page 1").toEqual(["b"]);

		const picked = [stroke("p", 1), stroke("q", 2), stroke("r", 1), stroke("s", 2)];
		expect(store.restoreRevision(DOC, page(picked)), "premise: a loaded record took the picked copy").toBe(true);

		// The eraser hit-tests the page read and indexes its op against it (PdfInkPenPath eraseAt). The nib is
		// over the page's first stroke; a partial erase takes it out and puts one piece back in its place.
		const onPage = store.strokesOnPage(DOC, 1);
		const under = onPage[0]!;
		const piece = stroke(`${under.id}1`, 1);
		store.applyLivePage(DOC, { type: "replace", path: DOC, removed: [under], removedAt: [0], inserted: [piece], insertedAt: [0] });

		expect.soft(under.id, "W1 the stroke under the nib is the picked copy's").toBe("p");
		expect.soft(ids(store.strokesOnPage(DOC, 1)), "W2 the page read after the sample").toEqual(["p1", "r"]);
		expect.soft(ids(store.strokes(DOC)), "W3 a whole read: the piece in p's place, the rest of the picked copy whole").toEqual(["p1", "q", "r", "s"]);
		const before = saved.length;
		const thrown = thrownBy(() => store.save(DOC));
		expect.soft(thrown, "W4 the save at pen-up does not throw").toBeNull();
		expect.soft(saved.slice(before).map((d) => ids(d.strokes)), "W5 the save writes it").toEqual([["p1", "q", "r", "s"]]);
	});

	it("pin: a restore with no erase live holds the picked copy, read and saved", async () => {
		const { store, saved } = await loaded();
		store.replaceAll(DOC, [stroke("a", 1), stroke("x", 2), stroke("b", 1), stroke("y", 2)]);
		const picked = [stroke("p", 1), stroke("q", 2), stroke("r", 1), stroke("s", 2)];
		expect(store.restoreRevision(DOC, page(picked)), "premise: a loaded record took the picked copy").toBe(true);

		expect.soft(ids(store.strokesOnPage(DOC, 1)), "W1 the page read serves the picked copy's page 1").toEqual(["p", "r"]);
		expect.soft(ids(store.strokes(DOC)), "W2 a whole read holds the picked copy").toEqual(["p", "q", "r", "s"]);
		const before = saved.length;
		const thrown = thrownBy(() => store.save(DOC));
		expect.soft(thrown, "W3 the save does not throw").toBeNull();
		expect.soft(saved.slice(before).map((d) => ids(d.strokes)), "W4 the save writes the picked copy").toEqual([["p", "q", "r", "s"]]);
	});
});
