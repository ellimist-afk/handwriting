/**
 * Live reload: another device wrote this document's sidecar, and the view has
 * to catch up without losing anything.
 *
 * Two cases carried over from the note store's reload suite, because both are
 * silent when wrong:
 *
 * - **Erase to empty.** A reload that reports "nothing was adopted" reads an
 *   erase as a non-event, and the ink stays on screen after another device
 *   removed it.
 * - **The no-op tick.** A reload that reports change whenever it read the file
 *   repaints on every poll, once a second, forever - and on a platform whose
 *   file times are approximate that is a permanent flicker.
 */

import { describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { PageData, ParseResult, emptyPage } from "../model/PageData";
import { PdfInkHost, PdfInkStore } from "./PdfInkStore";

function stroke(id: string, page = 1, x = 10): InkStroke {
	const points = [
		{ x, y: 10, pressure: 0.5, t: 0 },
		{ x: x + 10, y: 20, pressure: 0.5, t: 8 },
	];
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2,
		points,
		bbox: computeBBox(points, 4),
		createdAt: 0,
		page,
	};
}

/** A host whose sidecar contents can be swapped between reads. */
function harness(initial: InkStroke[]) {
	const state = { strokes: initial, damaged: false, future: false };
	const saved: PageData[] = [];
	const host: PdfInkHost = {
		load: (id) => {
			const data: PageData = { ...emptyPage(id), surface: "pdf", strokes: state.strokes };
			const result: ParseResult = { data, recovered: false };
			if (state.damaged) result.damaged = true;
			if (state.future) result.futureVersion = 99;
			return Promise.resolve(result);
		},
		schedule: (_id, data) => void saved.push(data),
		notice: () => {},
	};
	const store = new PdfInkStore();
	store.attachHost(host);
	return { store, state, saved };
}

describe("reloadExternal", () => {
	it("picks up ink another device added", async () => {
		const h = harness([stroke("a")]);
		await h.store.ensureLoaded("pdf-1");
		h.state.strokes = [stroke("a"), stroke("b")];
		expect(await h.store.reloadExternal("pdf-1")).toBe(true);
		expect(h.store.strokes("pdf-1").map((s) => s.id)).toEqual(["a", "b"]);
	});

	it("notices an erase to empty", async () => {
		// The case a count-based or adopted-based check reads as nothing
		// happening, leaving deleted ink on screen.
		const h = harness([stroke("a")]);
		await h.store.ensureLoaded("pdf-1");
		h.state.strokes = [];
		expect(await h.store.reloadExternal("pdf-1")).toBe(true);
		expect(h.store.strokes("pdf-1")).toEqual([]);
	});

	it("notices a move, which leaves the count alone", async () => {
		const h = harness([stroke("a", 1, 10)]);
		await h.store.ensureLoaded("pdf-1");
		h.state.strokes = [stroke("a", 1, 400)];
		expect(await h.store.reloadExternal("pdf-1")).toBe(true);
	});

	it("notices a stroke moving to another page", async () => {
		const h = harness([stroke("a", 1)]);
		await h.store.ensureLoaded("pdf-1");
		h.state.strokes = [stroke("a", 7)];
		expect(await h.store.reloadExternal("pdf-1")).toBe(true);
	});

	it("reports no change when the file says the same thing", async () => {
		// Every poll tick reaches here on a platform whose file times are
		// approximate. Reporting change would repaint once a second forever.
		const h = harness([stroke("a"), stroke("b")]);
		await h.store.ensureLoaded("pdf-1");
		expect(await h.store.reloadExternal("pdf-1")).toBe(false);
		expect(await h.store.reloadExternal("pdf-1")).toBe(false);
	});

	it("does nothing for a document it never loaded", async () => {
		const h = harness([stroke("a")]);
		expect(await h.store.reloadExternal("pdf-never")).toBe(false);
	});

	it("refuses while the sidecar is locked", async () => {
		// Dropping the record would clear the lock, and the next stroke would
		// write into a file we had already decided not to touch.
		const h = harness([]);
		h.state.damaged = true;
		await h.store.ensureLoaded("pdf-1");
		h.state.damaged = false;
		h.state.strokes = [stroke("a")];
		expect(await h.store.reloadExternal("pdf-1")).toBe(false);
		expect(h.store.strokes("pdf-1")).toEqual([]);
	});

	it("does not write anything back", async () => {
		// A reload is a read. Persisting what it found would race the device
		// that wrote it.
		const h = harness([stroke("a")]);
		await h.store.ensureLoaded("pdf-1");
		h.state.strokes = [stroke("a"), stroke("b")];
        await h.store.reloadExternal("pdf-1");
		expect(h.saved).toEqual([]);
	});
});
