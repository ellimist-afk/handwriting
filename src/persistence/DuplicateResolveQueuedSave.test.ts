/**
 * Duplicate resolution writes a save queued under the shared id before it clones, unless a live record names the id: the
 * copy's own record, or a live owner, whose record saves it under the shared id itself.
 *
 * The path: a sync brings `X 2.md`, a conflict copy carrying X's page id P, then deletes and recreates `X.md`. The delete
 * drops X's live record (inlineInk.handleDelete); the create is taken for the copy and resolveDuplicate runs on it. A stroke
 * drawn on X inside the store's 700 ms save delay is then only in P's queue. resolveDuplicate clones P's file from disk and,
 * with no live owner record, drops P's queue, so the stroke was in no file. Now the queue is written under P first and the
 * clone reads it: both files hold the stroke.
 *
 * Cells (real resolveDuplicate on a minimal plugin, real PageStore over FakeAdapter, real inline store):
 * - the sync's delete and create inside the save delay: the stroke is in P's file and in the clone;
 * - control, the copy's own record drew it: the stroke follows the copy to the new id and P's file is not written;
 * - control, the owner is live: it stays on P, its stroke is in P's file, and its next stroke still saves there;
 * - the owner is live: the clone is the shared page as it stood on disk; the owner's stroke still waiting is not in it.
 * - a newer file from outside at P: the write keeps it aside as a conflict copy, and the stroke drawn here is kept too.
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

const note = (id: string): string => `---\nhandwriting-page-id: ${id}\n---\nbody text\n`;

function rig() {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
	const notes = new Map<string, string>();
	const indexed = new Map<string, string | null>();
	inlineInk.attachHost({
		readPageId: (p: string) => indexed.get(p) ?? null,
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: (id: string) => store.load(id),
		scheduleSidecar: (id: string, p: PageData) => store.schedule(id, p),
		scheduleSidecarNow: (id: string, p: PageData) => store.saveNow(id, p),
		prepareExternalAdoption: (id: string, outgoing: PageData) => store.prepareExternalAdoption(id, outgoing),
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
		resolvingDuplicates: new Set<string>(),
		store,
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
		pageIds: { register: () => ({ kind: "registered" }), snapshot: () => ({}), owner: () => undefined },
		settings: { cameras: {}, pageOwners: {} },
		settingsDirty: false,
		settingsTimer: null,
		flushSettings: async () => {},
	});
	const resolve = (copyPath: string, id: string, ownerPath: string): Promise<void> =>
		(HandwritingPlugin.prototype as unknown as { resolveDuplicate: (c: string, i: string, o: string) => Promise<void> })
			.resolveDuplicate.call(self, copyPath, id, ownerPath);
	const put = (path: string, id: string) => {
		notes.set(path, note(id));
		indexed.set(path, id);
	};
	/** The sync's delete: the file goes, and the vault delete handler drops its live record. */
	const remove = (path: string) => {
		files.delete(path);
		notes.delete(path);
		indexed.delete(path);
		inlineInk.handleDelete(path);
	};
	/** Every stroke id in every ink file on disk, by file. */
	const onDisk = () => {
		const out: Record<string, string[]> = {};
		for (const [p, text] of fake.files) {
			if (!p.endsWith(".json") || p.includes("/trash/")) continue;
			const id = p.replace(/^.*\//, "").replace(/\.json$/, "");
			out[p] = parsePage(text, id).data.strokes.map((s) => s.id);
		}
		return out;
	};
	return { fake, store, notes, indexed, resolve, put, remove, onDisk };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const live = (id: string): string => `.handwriting/${id}.json`;

describe("duplicate resolution keeps a stroke still waiting to be saved under the shared id", () => {
	it("a sync deletes and recreates the note inside the save delay: the stroke is in the shared file and in the copy's", async () => {
		const r = rig();
		const P = "dq-shared-sync", X = "dq-x-sync.md", X2 = "dq-x-sync 2.md";
		r.fake.files.set(live(P), inlineBytes(P, ["old-1"]));
		r.fake.mtimes.set(live(P), 42);
		r.put(X, P);
		await inlineInk.ensureLoaded(X);
		inlineInk.commit(X, stroke("drawn-on-x"));
		expect(r.onDisk()[live(P)], "premise: the stroke is still waiting to be saved").toEqual(["old-1"]);
		r.put(X2, P);
		await vi.advanceTimersByTimeAsync(100);
		r.remove(X);
		r.put(X, P);
		await r.resolve(X, P, X2);
		const newId = r.indexed.get(X)!;
		expect(newId, "premise: the recreated note took a new id").not.toBe(P);
		await vi.advanceTimersByTimeAsync(5_000);
		const disk = r.onDisk();
		expect(disk[live(P)], `shared file (${JSON.stringify(disk)})`).toEqual(["old-1", "drawn-on-x"]);
		expect(disk[live(newId)], `copy's file (${JSON.stringify(disk)})`).toEqual(["old-1", "drawn-on-x"]);
	});

	it("control: the copy's own record drew the stroke; it goes with the copy to the new id and the shared file is not written", async () => {
		const r = rig();
		const P = "dq-shared-own", X = "dq-x-own.md", X2 = "dq-x-own 2.md";
		const before = inlineBytes(P, ["old-1"]);
		r.fake.files.set(live(P), before);
		r.fake.mtimes.set(live(P), 42);
		r.put(X, P);
		r.put(X2, P);
		await inlineInk.ensureLoaded(X2);
		inlineInk.commit(X2, stroke("drawn-on-copy"));
		expect(r.store.hasQueuedWrite(P), "premise: the copy's stroke is waiting under the shared id").toBe(true);
		await r.resolve(X2, P, X);
		const newId = r.indexed.get(X2)!;
		expect(newId, "premise: the copy took a new id").not.toBe(P);
		expect(inlineInk.pageIdOf(X2), "the copy's record follows it").toBe(newId);
		await vi.advanceTimersByTimeAsync(5_000);
		const disk = r.onDisk();
		expect(disk[live(newId)], `copy's file (${JSON.stringify(disk)})`).toEqual(["old-1", "drawn-on-copy"]);
		expect(r.fake.files.get(live(P)), "the shared file is byte for byte what it was").toBe(before);
		expect(r.fake.mtimes.get(live(P)), "and was not rewritten").toBe(42);
	});

	/** The owner X is live with a stroke waiting to be saved; `X 2.md` has no record and is resolved as the copy. */
	async function ownerLive(tag: string) {
		const r = rig();
		const P = `dq-shared-owner-${tag}`, X = `dq-x-owner-${tag}.md`, X2 = `dq-x-owner-${tag} 2.md`;
		r.fake.files.set(live(P), inlineBytes(P, ["old-1"]));
		r.fake.mtimes.set(live(P), 42);
		r.put(X, P);
		await inlineInk.ensureLoaded(X);
		inlineInk.commit(X, stroke("drawn-on-owner"));
		r.put(X2, P);
		await r.resolve(X2, P, X);
		const newId = r.indexed.get(X2)!;
		expect(newId, "premise: the copy took a new id").not.toBe(P);
		return { r, P, X, newId };
	}

	it("control: the owner is live; it stays on the shared id, its stroke is saved there, and so is its next one", async () => {
		const { r, P, X } = await ownerLive("stays");
		expect(inlineInk.pageIdOf(X), "the owner stays on the shared id").toBe(P);
		await vi.advanceTimersByTimeAsync(5_000);
		inlineInk.commit(X, stroke("owner-after"));
		await vi.advanceTimersByTimeAsync(5_000);
		const disk = r.onDisk();
		expect(disk[live(P)], `shared file (${JSON.stringify(disk)})`).toEqual(["old-1", "drawn-on-owner", "owner-after"]);
	});

	it("the owner is live: the copy is the shared page as it stood on disk at resolution, without the owner's stroke still waiting", async () => {
		const { r, newId } = await ownerLive("copy");
		await vi.advanceTimersByTimeAsync(5_000);
		const disk = r.onDisk();
		expect(disk[live(newId)], `copy's file (${JSON.stringify(disk)})`).toEqual(["old-1"]);
	});

	it("a newer file from outside at the shared id is kept aside as a conflict copy, and the stroke drawn here is kept too", async () => {
		const r = rig();
		const P = "dq-shared-ext", X = "dq-x-ext.md", X2 = "dq-x-ext 2.md";
		r.fake.files.set(live(P), inlineBytes(P, ["old-1"]));
		r.fake.mtimes.set(live(P), 42);
		r.put(X, P);
		await inlineInk.ensureLoaded(X);
		inlineInk.commit(X, stroke("drawn-on-x"));
		r.put(X2, P);
		// The sync also brings a newer shared file from the other device.
		r.fake.files.set(live(P), inlineBytes(P, ["old-1", "from-other-device"]));
		r.fake.mtimes.set(live(P), 99);
		await vi.advanceTimersByTimeAsync(100);
		r.remove(X);
		r.put(X, P);
		await r.resolve(X, P, X2);
		await vi.advanceTimersByTimeAsync(5_000);
		const disk = r.onDisk();
		const holders = (s: string) => Object.entries(disk).filter(([, ids]) => ids.includes(s)).map(([p]) => p);
		expect(holders("from-other-device").length, `the other device's file survives (${JSON.stringify(disk)})`).toBeGreaterThan(0);
		expect(holders("from-other-device").some((p) => p.includes(".conflict-")), "kept aside as a conflict copy").toBe(true);
		expect(holders("drawn-on-x").length, `the stroke drawn here survives (${JSON.stringify(disk)})`).toBeGreaterThan(0);
	});
});
