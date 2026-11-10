/**
 * Duplicate resolution can take the real note for the copy and drop its last strokes.
 *
 * The path as the sweep read it: a sync tool brings `X 2.md`, a conflict copy carrying X's page id P, then deletes and
 * recreates `X.md`. On the delete, `X 2.md` takes P (RecycleOnDelete onFileDeleted, claimOwnership) and X's live record is
 * dropped (the vault delete handler, inlineInk.handleDelete). On the create, `X.md` is taken for the copy and resolveDuplicate
 * runs on it: it clones P's ink file from disk under a new id, rewrites X.md to the new id, and, with no live record for
 * `X 2.md`, reassignPage answers "old-queue-orphaned" and discardPending(P) drops P's queued save. A stroke drawn on X inside
 * the store's 700 ms save delay is in that queue only: not in P's file, not in the clone.
 *
 * Covered here (unit, real code): the live record, the store's queue, the delete handler's record drop, and resolveDuplicate
 * with real PageStore over FakeAdapter. Taken as read, not run: that the delete hands P to `X 2.md` and that the create takes
 * X.md for the copy (pageIds, the metadata events); the cell starts resolveDuplicate where that leaves it.
 *
 * The failure: the stroke drawn on X before the delete is in no ink file once every timer has run.
 * Control: the same steps with the save delay run out before the delete; the stroke is on disk, and the cell reads it.
 *
 * Rig: the LateAsync-DuplicateRename rig (real resolveDuplicate on a minimal `this`, real PageStore over FakeAdapter, real
 * inlineInk store).
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
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
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
	/** The sync's delete: the file goes, and the vault delete handler drops its live record (PluginOnload). */
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

/**
 * X is open with ink on disk, a stroke is drawn on it, `X 2.md` arrives with P, the sync deletes and recreates X.md after
 * `gapMs`, and resolveDuplicate takes X.md for the copy with `X 2.md` the owner. Then every timer runs.
 */
async function scenario(tag: string, gapMs: number) {
	const r = rig();
	const P = `c2-shared-${tag}`, X = `c2-x-${tag}.md`, X2 = `c2-x-${tag} 2.md`, LIVE = `.handwriting/${P}.json`;
	r.fake.files.set(LIVE, inlineBytes(P, ["old-1"]));
	r.fake.mtimes.set(LIVE, 42);
	r.put(X, P);
	await inlineInk.ensureLoaded(X);
	expect(inlineInk.pageIdOf(X), "premise: X's live record is on P").toBe(P);
	inlineInk.commit(X, stroke("drawn-on-x"));
	expect(inlineInk.strokes(X).map((s) => s.id), "premise: the stroke is in X's live record").toContain("drawn-on-x");
	expect(r.onDisk()[LIVE], "premise: the stroke is not on disk yet (inside the save delay)").not.toContain("drawn-on-x");
	r.put(X2, P);
	await vi.advanceTimersByTimeAsync(gapMs);
	r.remove(X);
	r.put(X, P);
	await r.resolve(X, P, X2);
	const newId = r.indexed.get(X)!;
	expect(newId, "premise: resolveDuplicate gave X.md a new id").not.toBe(P);
	await vi.advanceTimersByTimeAsync(5_000);
	const disk = r.onDisk();
	const holders = Object.entries(disk).filter(([, ids]) => ids.includes("drawn-on-x")).map(([p]) => p);
	// eslint-disable-next-line no-console
	console.log(`C2 ${tag} gap ${gapMs} ms: newId ${newId}; ink files ${JSON.stringify(disk)}; stroke in ${JSON.stringify(holders)}`);
	return { holders, disk, newId };
}

describe("a stroke drawn on X survives a sync's delete and create of X with a conflict copy present", () => {
	it("control: the save delay runs out before the delete; the stroke is on disk", async () => {
		const c = await scenario("control", 1_000);
		expect(c.holders.length, "control: the stroke is in an ink file").toBeGreaterThan(0);
	});

	it("red cell: delete and recreate inside the 700 ms save delay; the stroke is in an ink file", async () => {
		const c = await scenario("inside", 100);
		expect(c.holders, `the stroke drawn on X is in no ink file (${JSON.stringify(c.disk)})`).not.toEqual([]);
	});
});
