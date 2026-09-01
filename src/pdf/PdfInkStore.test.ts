/**
 * The store's locks are the file. Everything else is a Map.
 *
 * Each test below stands for a way ink gets destroyed rather than a way the
 * code is shaped: a save landing mid-read, a placeholder overwriting a file it
 * could not parse, a newer format being rewritten by an older build. None of
 * them announce themselves - the ink is simply gone next time - so they are
 * asserted directly.
 */

import { describe, expect, it, vi } from "vitest";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { PageData, ParseResult, emptyPage } from "../model/PageData";
import { PDF_COORD_SPACE, PdfInkHost, PdfInkStore } from "./PdfInkStore";

function stroke(id: string, page: number): InkStroke {
	const points = [
		{ x: 10, y: 10, pressure: 0.5, t: 0 },
		{ x: 20, y: 20, pressure: 0.5, t: 8 },
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

function sidecar(id: string, strokes: InkStroke[], over: Partial<ParseResult> = {}): ParseResult {
	const data: PageData = { ...emptyPage(id), surface: "pdf", strokes };
	return { data, recovered: false, ...over };
}

function harness(result: ParseResult | null = null, hold?: Promise<void>) {
	const saved: PageData[] = [];
	const notices: string[] = [];
	const host: PdfInkHost = {
		load: async (id) => {
			if (hold) await hold;
			return result === null ? null : { ...result, data: { ...result.data, pageId: id } };
		},
		schedule: (_id, data) => void saved.push(data),
		notice: (m) => void notices.push(m),
	};
	const store = new PdfInkStore();
	store.attachHost(host);
	return { store, saved, notices };
}

describe("reading", () => {
	it("keeps strokes separated by page", () => {
		const { store } = harness();
		store.commit("pdf-a", stroke("s1", 1));
		store.commit("pdf-a", stroke("s2", 5));
		store.commit("pdf-a", stroke("s3", 1));
		expect(store.strokesOnPage("pdf-a", 1).map((s) => s.id)).toEqual(["s1", "s3"]);
		expect(store.strokesOnPage("pdf-a", 5).map((s) => s.id)).toEqual(["s2"]);
		expect(store.strokesOnPage("pdf-a", 2)).toEqual([]);
	});

	it("keeps documents apart", () => {
		const { store } = harness();
		store.commit("pdf-a", stroke("s1", 1));
		store.commit("pdf-b", stroke("s2", 1));
		expect(store.strokes("pdf-a").map((s) => s.id)).toEqual(["s1"]);
		expect(store.strokes("pdf-b").map((s) => s.id)).toEqual(["s2"]);
		expect(store.stats()).toEqual({ documents: 2, strokes: 2 });
	});

	it("says nothing about a document it has never seen", () => {
		const { store } = harness();
		expect(store.strokes("pdf-nothing")).toEqual([]);
		expect(store.hasInk("pdf-nothing")).toBe(false);
	});
});

describe("loading", () => {
	it("brings persisted ink into the session once", async () => {
		const { store } = harness(sidecar("pdf-a", [stroke("s1", 3)]));
		expect(await store.ensureLoaded("pdf-a")).toBe(true);
		expect(store.strokesOnPage("pdf-a", 3).map((s) => s.id)).toEqual(["s1"]);
		// A second call is a no-op, not a second merge.
		expect(await store.ensureLoaded("pdf-a")).toBe(false);
		expect(store.strokes("pdf-a").length).toBe(1);
	});

	it("ignores stored strokes with no page", async () => {
		// A note-surface stroke in a pdf sidecar has no page and no meaning
		// here; rendering it would put it on page 1 by accident.
		const orphan = { ...stroke("s1", 1) };
		delete (orphan as { page?: number }).page;
		const { store } = harness(sidecar("pdf-a", [orphan]));
		await store.ensureLoaded("pdf-a");
		expect(store.strokes("pdf-a")).toEqual([]);
	});
});

describe("the locks", () => {
	it("never lets a save mid-read replace what is on disk", async () => {
		// The one that eats a whole document. A stroke drawn while the sidecar
		// is still being read must not cause a snapshot of ONLY that stroke to
		// be written over the file.
		let release = (): void => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const { store, saved } = harness(sidecar("pdf-a", [stroke("old", 1)]), gate);
		const loading = store.ensureLoaded("pdf-a");
		store.commit("pdf-a", stroke("new", 2));
		expect(saved).toEqual([]); // nothing written while the read is open
		release();
		await loading;
		await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0));
		expect(saved[saved.length - 1]!.strokes.map((s) => s.id).sort()).toEqual(["new", "old"]);
	});

	it("refuses to write over a sidecar it could not parse", async () => {
		// `data` is a placeholder in this case, not the user's ink. Writing it
		// would replace a recoverable file with an empty one.
		const { store, saved, notices } = harness(
			sidecar("pdf-a", [], { damaged: true, problem: "bad json" })
		);
		await store.ensureLoaded("pdf-a");
		store.commit("pdf-a", stroke("s1", 1));
		expect(saved).toEqual([]);
		expect(notices.length).toBe(1);
	});

	it("refuses to rewrite a newer format", async () => {
		const { store, saved, notices } = harness(sidecar("pdf-a", [], { futureVersion: 99 }));
		await store.ensureLoaded("pdf-a");
		store.commit("pdf-a", stroke("s1", 1));
		expect(saved).toEqual([]);
		expect(notices.length).toBe(1);
	});

	it("says each thing once, however many strokes follow", async () => {
		const { store, notices } = harness(sidecar("pdf-a", [], { damaged: true }));
		await store.ensureLoaded("pdf-a");
		for (let i = 0; i < 5; i++) store.commit("pdf-a", stroke(`s${i}`, 1));
		expect(notices.length).toBe(1);
	});
});

describe("writing", () => {
	it("stamps the surface, so the note store can never adopt it", () => {
		// InlineInkStore legacy-locks any surface that is not "inline". That
		// guard is what keeps these two coordinate worlds apart, and it only
		// works if this is written every time.
		const { store, saved } = harness();
		store.commit("pdf-a", stroke("s1", 1));
		expect(saved[0]!.surface).toBe("pdf");
		expect(saved[0]!.pageId).toBe("pdf-a");
	});

	it("stamps the coordinate space on every write", () => {
		const { store, saved } = harness();
		store.commit("pdf-a", stroke("s1", 1));
		expect(saved[0]!.coordSpace).toBe(PDF_COORD_SPACE);
	});

	it("preserves keys it did not write", async () => {
		// A sidecar from a newer build may carry fields this version does not
		// know. Round-tripping them is what makes a downgrade non-destructive.
		const withExtra = sidecar("pdf-a", [stroke("s1", 1)]);
		withExtra.data.unknownTop = { somethingNew: 42 };
		const { store, saved } = harness(withExtra);
		await store.ensureLoaded("pdf-a");
		store.commit("pdf-a", stroke("s2", 1));
		expect(saved[0]!.unknownTop).toEqual({ somethingNew: 42 });
	});

	it("persists an empty set, so erasing the last stroke sticks", () => {
		const { store, saved } = harness();
		store.commit("pdf-a", stroke("s1", 1));
		store.replaceAll("pdf-a", []);
		expect(saved[saved.length - 1]!.strokes).toEqual([]);
	});

	it("writes nothing at all without a host", () => {
		const store = new PdfInkStore();
		expect(() => store.commit("pdf-a", stroke("s1", 1))).not.toThrow();
		expect(store.strokes("pdf-a").length).toBe(1);
	});
});

/** Two reads with different answers: the first lands, the second fails. */
function twoReads(first: ParseResult | null, second: ParseResult | null) {
	const saved: PageData[] = [];
	let call = 0;
	const host: PdfInkHost = {
		load: async (id) => {
			const r = call++ === 0 ? first : second;
			return r === null ? null : { ...r, data: { ...r.data, pageId: id } };
		},
		schedule: (_id, data) => void saved.push(data),
		notice: () => {},
	};
	const store = new PdfInkStore();
	store.attachHost(host);
	return { store, saved };
}

describe("a re-read that fails", () => {
	// The poll fires BECAUSE the file just changed, which is exactly when a
	// sync client is most likely to be part-way through writing it. Clearing
	// the session before the re-read lands is only safe if the re-read lands.
	it("keeps what was on screen when the sidecar comes back unreadable", async () => {
		const damaged: ParseResult = { data: emptyPage("pdf-a"), recovered: true, damaged: true };
		const { store } = twoReads(sidecar("pdf-a", [stroke("s1", 1)]), damaged);
		await store.ensureLoaded("pdf-a");
		expect(store.strokes("pdf-a")).toHaveLength(1);

		expect(await store.reloadExternal("pdf-a")).toBe(false);
		// Still on screen, and the lock means nothing will overwrite the file.
		expect(store.strokes("pdf-a").map((s) => s.id)).toEqual(["s1"]);
	});

	it("keeps what was on screen when the sidecar has gone", async () => {
		const { store } = twoReads(sidecar("pdf-a", [stroke("s1", 1)]), null);
		await store.ensureLoaded("pdf-a");

		await store.reloadExternal("pdf-a");
		// The session copy is now the only copy in existence.
		expect(store.strokes("pdf-a").map((s) => s.id)).toEqual(["s1"]);
	});
});

describe("strokes the read cannot place", () => {
	it("carries them back to disk instead of dropping them", async () => {
		const orphan = { ...stroke("orphan", 1), page: undefined } as unknown as InkStroke;
		const { store, saved } = harness(sidecar("pdf-a", [orphan, stroke("s1", 1)]));
		await store.ensureLoaded("pdf-a");
		// Not drawn: a stroke with no page cannot be put on one.
		expect(store.strokes("pdf-a").map((s) => s.id)).toEqual(["s1"]);

		store.commit("pdf-a", stroke("s2", 2));
		// But still in the file. Filtering is not deleting.
		expect(saved.at(-1)!.strokes.map((s) => s.id)).toEqual(["orphan", "s1", "s2"]);
	});
});

describe("path claims (instance identity)", () => {
	it("a fresh instance claims lazily: opening writes nothing, the first stroke writes the claim", () => {
		const { store, saved } = harness();
		store.claimPath("pdf-a", "copy.pdf");
		expect(saved).toHaveLength(0); // merely opening a pdf never creates a sidecar
		store.commit("pdf-a", stroke("s1", 1));
		expect(saved).toHaveLength(1);
		expect(saved[0]!.pdfPaths).toEqual(["copy.pdf"]);
	});

	it("an adoption on a loaded sidecar is durable at once", async () => {
		const { store, saved } = harness(sidecar("pdf-a", [stroke("old", 1)]));
		await store.ensureLoaded("pdf-a");
		store.claimPath("pdf-a", "renamed.pdf");
		expect(saved).toHaveLength(1);
		expect(saved[0]!.pdfPaths).toEqual(["renamed.pdf"]);
		// And a repeat claim is a no-op, not a second write.
		store.claimPath("pdf-a", "renamed.pdf");
		expect(saved).toHaveLength(1);
	});

	it("claims made before the read landed survive it, merged with the disk's", async () => {
		const base = sidecar("pdf-a", []);
		base.data.pdfPaths = ["from-disk.pdf"];
		const { store, saved } = harness(base);
		store.claimPath("pdf-a", "session.pdf");
		await store.ensureLoaded("pdf-a");
		store.commit("pdf-a", stroke("s1", 1));
		expect(saved.at(-1)!.pdfPaths?.slice().sort()).toEqual(["from-disk.pdf", "session.pdf"]);
	});

	it("a rename replaces the old claim rather than accumulating it", async () => {
		const base = sidecar("pdf-a", [stroke("old", 1)]);
		base.data.pdfPaths = ["before.pdf"];
		const { store, saved } = harness(base);
		await store.ensureLoaded("pdf-a");
		store.renamePath("pdf-a", "before.pdf", "after.pdf");
		expect(saved.at(-1)!.pdfPaths).toEqual(["after.pdf"]);
	});

	it("a sidecar with no claims stays claimless until someone claims it", async () => {
		const { store, saved } = harness(sidecar("pdf-a", [stroke("old", 1)]));
		await store.ensureLoaded("pdf-a");
		store.commit("pdf-a", stroke("s1", 1));
		// Pre-instance data round-trips without inventing a pdfPaths field.
		expect(saved.at(-1)!.pdfPaths).toEqual([]);
	});
});
