/**
 * The original note is renamed while its copy is being given its own id.
 *
 * resolveDuplicate takes the owner's path when it starts. The original can be
 * renamed during the sidecar clone or the copy's frontmatter rewrite; the
 * live record and the id ledger both follow the rename. The repair must then
 * reschedule the original under its new path, so its pending save (the last
 * strokes before the debounce fires) still lands in its ink file.
 *
 * Rig: real resolveDuplicate on a minimal `this`, real PageStore over
 * FakeAdapter, real inlineInk store, real PageIdIndex, TFile objects that
 * follow a rename the way Obsidian's do.
 *
 * Assertions state the correct behaviour: green = no bug, red = bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
		Notice: class {
			hide(): void {
				/* no-op */
			}
		},
	};
});

import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageIdIndex } from "../model/PageIdIndex";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 1, y: 2, pressure: 0.5, t: 0 },
			{ x: 11, y: 6, pressure: 0.5, t: 8 },
		],
		bbox: { x: 1, y: 2, width: 10, height: 4 },
		createdAt: 0,
	};
}

function inlineBytes(id: string, ids: string[]): string {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = ids.map(stroke);
	return serializePage(p);
}

function note(id: string): string {
	return `---\nhandwriting-page-id: ${id}\n---\nbody text\n`;
}

function rig() {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
	const notes = new Map<string, string>();
	const indexed = new Map<string, string | null>();
	const pageIds = new PageIdIndex();
	inlineInk.attachHost({
		readPageId: (p: string) => indexed.get(p) ?? null,
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: (id: string) => store.load(id),
		scheduleSidecar: (id: string, p: PageData) => store.schedule(id, p),
		scheduleSidecarNow: (id: string, p: PageData) => store.saveNow(id, p),
		prepareExternalAdoption: (id: string, outgoing: PageData) =>
			store.prepareExternalAdoption(id, outgoing),
		acceptExternalAdoption: (prepared: never) => store.acceptExternalAdoption(prepared),
		notify: () => {},
	} as never);
	const files = new Map<string, { path: string; basename: string }>();
	const file = (path: string) => {
		let f = files.get(path);
		if (!f) {
			f = { path, basename: path.replace(/\.md$/, "") };
			files.set(path, f);
		}
		return f;
	};
	const self = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		resolvingDuplicates: new Set<unknown>(),
		store,
		pageIds,
		app: {
			vault: {
				getFileByPath: (p: string) => (notes.has(p) ? file(p) : null),
				process: async (f: { path: string }, fn: (data: string) => string) => {
					if (!notes.has(f.path)) throw new Error(`ENOENT: no such file, open '${f.path}'`);
					const next = fn(notes.get(f.path)!);
					notes.set(f.path, next);
					const m = /handwriting-page-id:\s*(\S+)/.exec(next);
					indexed.set(f.path, m ? m[1]! : null);
					return next;
				},
			},
		},
		settings: { cameras: {}, pageOwners: {} },
		settingsDirty: false,
		settingsTimer: null,
		flushSettings: async () => {},
	});
	const resolve = (copyPath: string, id: string, ownerPath: string): Promise<void> =>
		(
			HandwritingPlugin.prototype as unknown as {
				resolveDuplicate: (c: string, i: string, o: string) => Promise<void>;
			}
		).resolveDuplicate.call(self, copyPath, id, ownerPath);
	/** Obsidian's rename: the TFile keeps its identity; both handlers follow. */
	const rename = (from: string, to: string): void => {
		const f = file(from);
		files.delete(from);
		f.path = to;
		f.basename = to.replace(/\.md$/, "");
		files.set(to, f);
		notes.set(to, notes.get(from)!);
		notes.delete(from);
		indexed.set(to, indexed.get(from) ?? null);
		indexed.delete(from);
		pageIds.handleRename(from, to);
		inlineInk.handleRename(from, to);
	};
	/** The note is deleted: its file is gone and both handlers forget it. */
	const remove = (path: string): void => {
		files.delete(path);
		notes.delete(path);
		indexed.delete(path);
		pageIds.handleDelete(path);
		inlineInk.handleDelete(path);
	};
	/** Hold the first page-ink clone until `release` runs. */
	const holdClone = () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const real = store.clone.bind(store);
		vi.spyOn(store, "clone").mockImplementationOnce(async (from: string, to: string) => {
			await gate;
			return real(from, to);
		});
		return () => release();
	};
	return { fake, store, notes, indexed, pageIds, resolve, rename, remove, holdClone };
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
}

function savedIds(fake: FakeAdapter, id: string): string[] {
	const raw = fake.files.get(`.handwriting/${id}.json`);
	if (raw === undefined) return [];
	return parsePage(raw, id).data.strokes.map((s) => s.id);
}

/** The original at `orig` is open, owns `shared`, and holds one unsaved stroke. */
async function originalWithPendingStroke(
	r: ReturnType<typeof rig>,
	shared: string,
	orig: string,
	copy: string
): Promise<void> {
	r.fake.files.set(`.handwriting/${shared}.json`, inlineBytes(shared, ["orig-1"]));
	r.fake.mtimes.set(`.handwriting/${shared}.json`, 42);
	r.notes.set(orig, note(shared));
	r.notes.set(copy, note(shared));
	r.indexed.set(orig, shared);
	r.indexed.set(copy, shared);
	r.pageIds.register(orig, shared);
	await inlineInk.ensureLoaded(orig);
	expect(inlineInk.pageIdOf(orig)).toBe(shared);
	inlineInk.commit(orig, stroke("orig-new"));
	// Precondition: the stroke is not on disk yet (the save is debounced).
	expect(savedIds(r.fake, shared)).toEqual(["orig-1"]);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("the original renamed while its copy gets its own id", () => {
	it("control: no rename, the original's unsaved stroke is saved", async () => {
		const r = rig();
		const SHARED = "ren-orig-shared-a";
		await originalWithPendingStroke(r, SHARED, "ren-orig-a.md", "ren-copy-a.md");

		const release = r.holdClone();
		const repair = r.resolve("ren-copy-a.md", SHARED, "ren-orig-a.md");
		await settle();
		release();
		await repair;
		await r.store.flush();

		const newId = r.indexed.get("ren-copy-a.md")!;
		expect(newId).not.toBe(SHARED);
		expect(savedIds(r.fake, SHARED)).toEqual(["orig-1", "orig-new"]);
		// No ink twice: the original's new stroke never lands in the copy's file.
		expect(savedIds(r.fake, newId)).not.toContain("orig-new");
	});

	it("renamed during the sidecar clone: the original's unsaved stroke is still saved", async () => {
		const r = rig();
		const SHARED = "ren-orig-shared-b";
		await originalWithPendingStroke(r, SHARED, "ren-orig-b.md", "ren-copy-b.md");

		const release = r.holdClone();
		const repair = r.resolve("ren-copy-b.md", SHARED, "ren-orig-b.md");
		await settle();
		r.rename("ren-orig-b.md", "ren-orig-b2.md");
		expect(inlineInk.pageIdOf("ren-orig-b2.md"), "the rename did not move the live record").toBe(SHARED);
		expect(r.pageIds.owner(SHARED), "the rename did not move the owner").toBe("ren-orig-b2.md");
		release();
		await repair;
		await r.store.flush();

		const newId = r.indexed.get("ren-copy-b.md")!;
		expect(newId, "the copy never got a fresh id").not.toBe(SHARED);
		expect(inlineInk.pageIdOf("ren-orig-b2.md")).toBe(SHARED);
		expect(savedIds(r.fake, SHARED), "the original's last stroke was dropped").toEqual(["orig-1", "orig-new"]);
		// No ink twice: the original's new stroke never lands in the copy's file.
		expect(savedIds(r.fake, newId)).not.toContain("orig-new");
	});

	it("deleted during the sidecar clone: the orphaned queue under the old id is still discarded", async () => {
		const r = rig();
		const SHARED = "ren-orig-shared-c";
		await originalWithPendingStroke(r, SHARED, "ren-orig-c.md", "ren-copy-c.md");
		const discard = vi.spyOn(r.store, "discardPending");

		const release = r.holdClone();
		const repair = r.resolve("ren-copy-c.md", SHARED, "ren-orig-c.md");
		await settle();
		r.remove("ren-orig-c.md");
		expect(r.pageIds.owner(SHARED)).toBeUndefined();
		release();
		await repair;

		expect(r.indexed.get("ren-copy-c.md")).not.toBe(SHARED);
		expect(discard).toHaveBeenCalledWith(SHARED);
	});

	it("the ledger names the copy itself as owner: no owner, the old queue is discarded", async () => {
		const r = rig();
		const SHARED = "ren-orig-shared-d";
		await originalWithPendingStroke(r, SHARED, "ren-orig-d.md", "ren-copy-d.md");
		const discard = vi.spyOn(r.store, "discardPending");

		const release = r.holdClone();
		const repair = r.resolve("ren-copy-d.md", SHARED, "ren-orig-d.md");
		await settle();
		r.pageIds.transfer(SHARED, "ren-copy-d.md");
		release();
		await repair;

		expect(r.indexed.get("ren-copy-d.md")).not.toBe(SHARED);
		expect(discard).toHaveBeenCalledWith(SHARED);
	});

	it("the ledger names the copy itself while the copy is open: still no owner, the old queue is discarded", async () => {
		const r = rig();
		const SHARED = "ren-orig-shared-e";
		await originalWithPendingStroke(r, SHARED, "ren-orig-e.md", "ren-copy-e.md");
		// The copy is open too: it has a live record under the shared id, so a
		// lookup by its path finds a record that could pass for the owner's.
		await inlineInk.ensureLoaded("ren-copy-e.md");
		expect(inlineInk.pageIdOf("ren-copy-e.md"), "the copy has no live record").toBe(SHARED);
		const discard = vi.spyOn(r.store, "discardPending");

		const release = r.holdClone();
		const repair = r.resolve("ren-copy-e.md", SHARED, "ren-orig-e.md");
		await settle();
		r.pageIds.transfer(SHARED, "ren-copy-e.md");
		release();
		await repair;

		const newId = r.indexed.get("ren-copy-e.md")!;
		expect(newId).not.toBe(SHARED);
		expect(inlineInk.pageIdOf("ren-copy-e.md"), "the copy's live record did not follow its new id").toBe(newId);
		expect(discard, "the copy was taken for the owner").toHaveBeenCalledWith(SHARED);
	});
});
