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
	scheduleSidecar(pageId: string): void {
		this.scheduled.push(pageId);
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
});
