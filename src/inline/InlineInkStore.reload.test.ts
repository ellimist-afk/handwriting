/**
 * External reload (live sync): a clean, settled record adopts a sidecar
 * another device wrote, through the normal load path. The poll gates
 * (disk actually changed, no active gesture) live outside the store; what
 * is under test here is that the record-side guards hold and the adopted
 * content is what renders.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InlineInkStore, InlineInkHost } from "./InlineInkStore";
import { PageData, ParseResult, emptyPage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 0 },
		createdAt: 0,
	} as InkStroke;
}

function pageWith(id: string, ...strokeIds: string[]): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = strokeIds.map(stroke);
	return p;
}

function ok(data: PageData): ParseResult {
	return { data, recovered: false, damaged: false } as ParseResult;
}

class FakeHost implements InlineInkHost {
	sidecars = new Map<string, ParseResult>();
	scheduled: string[] = [];
	readPageId(path: string): string | null {
		return path === "note.md" ? "p1" : null;
	}
	async claimId(_path: string, proposedId: string): Promise<{ pageId: string }> {
		return { pageId: proposedId };
	}
	async loadSidecar(pageId: string): Promise<ParseResult | null> {
		return this.sidecars.get(pageId) ?? null;
	}
	/** The PAGE as well as the id: what a save actually puts on disk. */
	scheduledPages: PageData[] = [];
	scheduleSidecar(pageId: string, page: PageData): void {
		this.scheduled.push(pageId);
		this.scheduledPages.push(page);
	}
	notify(): void {}
}

describe("InlineInkStore.reloadExternal", () => {
	let store: InlineInkStore;
	let host: FakeHost;

	beforeEach(() => {
		store = new InlineInkStore();
		host = new FakeHost();
		store.attachHost(host);
	});

	it("adopts remote strokes into a loaded, clean record", async () => {
		host.sidecars.set("p1", ok(pageWith("p1", "local-a")));
		await store.ensureLoaded("note.md");
		expect(store.strokes("note.md").map((s) => s.id)).toEqual(["local-a"]);

		host.sidecars.set("p1", ok(pageWith("p1", "local-a", "remote-b")));
		expect(await store.reloadExternal("note.md")).toBe(true);
		expect(store.strokes("note.md").map((s) => s.id)).toEqual(["local-a", "remote-b"]);
	});

	it("erasing everything remotely still reports a reload (the stale-pixels case)", async () => {
		host.sidecars.set("p1", ok(pageWith("p1", "a", "b")));
		await store.ensureLoaded("note.md");
		expect(store.strokes("note.md").length).toBe(2);

		host.sidecars.set("p1", ok(pageWith("p1")));
		expect(await store.reloadExternal("note.md")).toBe(true);
		expect(store.strokes("note.md").length).toBe(0);
	});

	it("identical content reports no reload (ios stat-misfire flicker)", async () => {
		host.sidecars.set("p1", ok(pageWith("p1", "a", "b")));
		await store.ensureLoaded("note.md");
		expect(await store.reloadExternal("note.md")).toBe(false);
		expect(store.strokes("note.md").length).toBe(2);
	});

	it("exposes the recorded page id for the poll", async () => {
		host.sidecars.set("p1", ok(pageWith("p1", "a")));
		await store.ensureLoaded("note.md");
		expect(store.pageIdOf("note.md")).toBe("p1");
		expect(store.pageIdOf("other.md")).toBe(null);
	});

	it("refuses a duplicate-locked record: the lock must not silently reset", async () => {
		host.sidecars.set("p1", ok(pageWith("p1", "a")));
		await store.ensureLoaded("note.md");
		store.markDuplicateLocked("note.md", "copy of note.md");

		host.sidecars.set("p1", ok(pageWith("p1", "a", "b")));
		expect(await store.reloadExternal("note.md")).toBe(false);
		// the lock survived: the record was not rebuilt
		expect(store.strokes("note.md").map((s) => s.id)).toEqual(["a"]);
	});

	it("refuses a record that was never loaded", async () => {
		expect(await store.reloadExternal("note.md")).toBe(false);
	});

	it("refuses without a host (session-memory mode)", async () => {
		const bare = new InlineInkStore();
		expect(await bare.reloadExternal("note.md")).toBe(false);
	});

	// The poll fires BECAUSE the file just changed, so it lands on exactly
	// the moments a sync client is part-way through writing one. Clearing
	// the record before the re-read succeeded emptied the note on screen and
	// left it unable to save until it was reopened. PdfInkStore has guarded
	// this since it was written; these pin the same guard here.
	it("a sidecar caught mid-sync leaves the ink on screen", async () => {
		host.sidecars.set("p1", ok(pageWith("p1", "a", "b")));
		await store.ensureLoaded("note.md");

		const midWrite = ok(pageWith("p1"));
		midWrite.damaged = true;
		host.sidecars.set("p1", midWrite);
		expect(await store.reloadExternal("note.md")).toBe(false);
		expect(store.strokes("note.md").map((s) => s.id)).toEqual(["a", "b"]);
	});

	it("a sidecar that has gone leaves the only remaining copy alone", async () => {
		host.sidecars.set("p1", ok(pageWith("p1", "a")));
		await store.ensureLoaded("note.md");

		host.sidecars.delete("p1");
		expect(await store.reloadExternal("note.md")).toBe(false);
		expect(store.strokes("note.md").map((s) => s.id)).toEqual(["a"]);
		// And the note can still save, which is what rebuilding the record
		// took away: the id was gone until the next claim.
		expect(store.pageIdOf("note.md")).toBe("p1");
		store.save("note.md");
		expect(host.scheduled).toContain("p1");
	});

	it("a future-locked reload keeps the session ink too", async () => {
		host.sidecars.set("p1", ok(pageWith("p1", "a")));
		await store.ensureLoaded("note.md");

		const future = ok(pageWith("p1"));
		future.futureVersion = 99;
		host.sidecars.set("p1", future);
		expect(await store.reloadExternal("note.md")).toBe(false);
		expect(store.strokes("note.md").map((s) => s.id)).toEqual(["a"]);
	});

	// Read-only, not invisible. A note whose sidecar came from a newer build
	// used to show NO ink at all on this surface, while the canvas view had
	// always rendered what it recognised and refused to write it. Showing
	// nothing reads as exactly the data loss the lock exists to prevent.
	it("renders what it can from a newer-schema sidecar, still locked", async () => {
		const bare = new InlineInkStore();
		const h = new FakeHost();
		bare.attachHost(h);
		const future = ok(pageWith("p1", "from-the-future"));
		future.futureVersion = 99;
		h.sidecars.set("p1", future);

		await bare.ensureLoaded("note.md");
		expect(bare.strokes("note.md").map((s) => s.id)).toEqual(["from-the-future"]);
		// Rendered, and still not writable: a save must not reach the host.
		bare.save("note.md");
		expect(h.scheduled).toEqual([]);
	});

	it("a damaged remote sidecar locks the record instead of rendering junk", async () => {
		host.sidecars.set("p1", ok(pageWith("p1", "a")));
		await store.ensureLoaded("note.md");

		const bad = ok(pageWith("p1"));
		bad.damaged = true;
		host.sidecars.set("p1", bad);
		await store.reloadExternal("note.md");
		// The reload ran the normal load path, so the damage lock re-applied
		// and a FURTHER reload refuses to touch the locked record.
		expect(await store.reloadExternal("note.md")).toBe(false);
	});

	// The strokes were put back and the BASE PAGE was not, and the next save
	// wrote that emptiness to disk. Nothing looks wrong at the moment of the
	// failed re-read - the record still renders the kept strokes - so the
	// loss (images, and any field a newer build wrote that this one only
	// carries through unread) only shows up when the note is reopened
	// somewhere the geometry is simply gone. Port of efea5c1 on the 1.5.0
	// line, which pins the same guard for that build's text boxes.
	it("a sidecar that has gone leaves the note's images and unknown fields alone too", async () => {
		const page = pageWith("p1", "a");
		page.images = [{ id: "img-1", x: 10, y: 20, width: 100, height: 80, z: 0 }];
		page.unknownTop = { futureField: "keep-me" };
		host.sidecars.set("p1", ok(page));
		await store.ensureLoaded("note.md");

		// The file is gone (a sync client deleted and recreated it), so the
		// re-read reads nothing and the record has to be put back whole.
		host.sidecars.delete("p1");
		expect(await store.reloadExternal("note.md")).toBe(false);
		expect(store.strokes("note.md").map((s) => s.id)).toEqual(["a"]);

		// And the write that follows carries the image and the unknown field,
		// rather than erasing them from a record whose basePage had been
		// cleared and never put back.
		store.save("note.md");
		const written = host.scheduledPages.at(-1);
		expect(written?.images.map((im) => im.id)).toEqual(["img-1"]);
		expect(written?.unknownTop).toEqual({ futureField: "keep-me" });
	});
});
