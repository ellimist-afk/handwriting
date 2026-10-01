/**
 * AUDIT PROBE InlineStore-1 (read-only audit of 1.4.21, tag 1a05f62c).
 *
 * Claim: reassignPage (InlineInkStore.ts:1622-1642) calls schedule() directly
 * on the copy's record and on the owner's record. schedule() has no load
 * check and snapshot() falls back to emptyPage when basePage is null, so a
 * record that does not hold the sidecar yet (never loaded, loaded before the
 * metadata cache knew its id, or mid-load) queues an EMPTY page. PageStore
 * then writes it over the fresh clone (copy) or over the original sidecar
 * (owner mid-load).
 *
 * Production code driven: the real HandwritingPlugin.prototype.resolveDuplicate
 * (main.ts:3933-3990) on a minimal `this`, the real PageStore over the
 * in-memory FakeAdapter, and the real module-level `inlineInk` store with its
 * host wired as main.ts:2033-2046 wires it.
 *
 * Assertions state the CORRECT behaviour: green = no bug, red = bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
		Notice: class {
			constructor(message: string) {
				notices.list.push(message);
			}
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

function note(id: string): string {
	return `---\nhandwriting-page-id: ${id}\n---\nbody text\n`;
}

/** An adapter whose FIRST read of one path is held until released. */
class GatedAdapter extends FakeAdapter {
	gatePath: string | null = null;
	private gate: Promise<void> | null = null;
	release: () => void = () => {};
	armGate(path: string): void {
		this.gatePath = path;
		this.gate = new Promise<void>((r) => (this.release = r));
	}
	override async read(path: string): Promise<string> {
		if (this.gate && path === this.gatePath) {
			const g = this.gate;
			this.gate = null; // only the first read of that path waits
			await g;
		}
		return super.read(path);
	}
}

interface Rig {
	fake: GatedAdapter;
	store: PageStore;
	/** Note text on disk. */
	notes: Map<string, string>;
	/** What the metadata cache has indexed (readPageId answers from this). */
	indexed: Map<string, string | null>;
	resolve: (copyPath: string, id: string, ownerPath: string) => Promise<void>;
	sidecarIds: (id: string) => string[] | null;
}

function rig(): Rig {
	const fake = new GatedAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
	const notes = new Map<string, string>();
	const indexed = new Map<string, string | null>();
	// Host wired as main.ts:2033-2046 (readPageId = the metadata cache).
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
	const file = (path: string) => ({ path, basename: path.replace(/\.md$/, "") });
	const self = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		resolvingDuplicates: new Set<string>(),
		store,
		app: {
			vault: {
				getFileByPath: (p: string) => (notes.has(p) ? file(p) : null),
				process: async (f: { path: string }, fn: (data: string) => string) => {
					const next = fn(notes.get(f.path)!);
					notes.set(f.path, next);
					// The metadata cache follows the rewrite.
					const m = /handwriting-page-id:\s*(\S+)/.exec(next);
					indexed.set(f.path, m ? m[1]! : null);
					return next;
				},
			},
		},
		pageIds: { register: () => ({ kind: "registered" }), snapshot: () => ({}) },
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
	const sidecarIds = (id: string): string[] | null => {
		const text = fake.files.get(`.handwriting/${id}.json`);
		if (text === undefined) return null;
		return parsePage(text, id).data.strokes.map((s) => s.id);
	};
	return { fake, store, notes, indexed, resolve, sidecarIds };
}

async function drain(): Promise<void> {
	for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(1000);
	for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	notices.list.length = 0;
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("InlineStore-1: duplicate repair must not write an empty page over saved ink", () => {
	it("copy never loaded (census markDuplicateLocked record): the clone keeps the ink", async () => {
		const r = rig();
		const SHARED = "shared-a";
		r.fake.files.set(`.handwriting/${SHARED}.json`, inlineBytes(SHARED, ["orig-1", "orig-2"]));
		r.fake.mtimes.set(`.handwriting/${SHARED}.json`, 42);
		r.notes.set("orig-a.md", note(SHARED));
		r.notes.set("copy-a.md", note(SHARED));
		r.indexed.set("orig-a.md", SHARED);
		r.indexed.set("copy-a.md", SHARED);

		// Census, ambiguous duplicate (main.ts:3791-3796): both carriers get a
		// fresh, never-loaded, duplicate-locked record.
		inlineInk.markDuplicateLocked("orig-a.md", "copy-a.md");
		inlineInk.markDuplicateLocked("copy-a.md", "orig-a.md");
		// Precondition: the copy's record exists and does NOT hold the sidecar.
		expect(inlineInk.isDuplicateLocked("copy-a.md")).toBe(true);
		expect(inlineInk.isLoaded("copy-a.md")).toBe(false);
		expect(inlineInk.pageIdOf("copy-a.md")).toBeNull();

		// Carrier B's "changed" event -> resolveDuplicate (main.ts:3933-3990).
		await r.resolve("copy-a.md", SHARED, "orig-a.md");
		const newId = r.indexed.get("copy-a.md")!;
		expect(newId).not.toBe(SHARED);
		expect(inlineInk.pageIdOf("copy-a.md")).toBe(newId);
		// Precondition: the clone exists and holds the ink the notice promises.
		expect(r.sidecarIds(newId)).toEqual(["orig-1", "orig-2"]);
		expect(notices.list.some((n) => n.includes("an independent copy of the ink"))).toBe(true);

		await drain();

		// CORRECT: the clone still holds the copied ink after the debounce.
		expect(r.sidecarIds(newId)).toEqual(["orig-1", "orig-2"]);
		// The original is untouched either way.
		expect(r.sidecarIds(SHARED)).toEqual(["orig-1", "orig-2"]);
	});

	it("copy loaded before its metadata was indexed (load yes, pageId null): the clone keeps the ink", async () => {
		const r = rig();
		const SHARED = "shared-b";
		r.fake.files.set(`.handwriting/${SHARED}.json`, inlineBytes(SHARED, ["orig-1"]));
		r.fake.mtimes.set(`.handwriting/${SHARED}.json`, 42);
		r.notes.set("orig-b.md", note(SHARED));
		r.notes.set("copy-b.md", note(SHARED));
		r.indexed.set("orig-b.md", SHARED);
		// Not indexed yet: the overlay mounts and loads the brand-new note.
		r.indexed.set("copy-b.md", null);
		await inlineInk.ensureLoaded("copy-b.md");
		expect(inlineInk.isLoaded("copy-b.md")).toBe(true);
		expect(inlineInk.pageIdOf("copy-b.md")).toBeNull();
		// Metadata cache catches up; the "changed" event finds the duplicate.
		r.indexed.set("copy-b.md", SHARED);

		await r.resolve("copy-b.md", SHARED, "orig-b.md");
		const newId = r.indexed.get("copy-b.md")!;
		expect(newId).not.toBe(SHARED);
		expect(r.sidecarIds(newId)).toEqual(["orig-1"]); // precondition: clone written

		await drain();

		// CORRECT: the clone still holds the copied ink.
		expect(r.sidecarIds(newId)).toEqual(["orig-1"]);
	});

	it("owner mid-load when the repair runs: the ORIGINAL sidecar keeps its ink", async () => {
		const r = rig();
		const SHARED = "shared-c";
		const LIVE = `.handwriting/${SHARED}.json`;
		r.fake.files.set(LIVE, inlineBytes(SHARED, ["orig-1", "orig-2", "orig-3"]));
		r.fake.mtimes.set(LIVE, 42);
		r.notes.set("orig-c.md", note(SHARED));
		r.notes.set("copy-c.md", note(SHARED));
		r.indexed.set("orig-c.md", SHARED);
		r.indexed.set("copy-c.md", SHARED);

		// The owner's tab is restoring: its sidecar read is in flight.
		r.fake.armGate(LIVE);
		const ownerLoad = inlineInk.ensureLoaded("orig-c.md");
		for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
		// Precondition: owner has its id (set before the await) but is not loaded.
		expect(inlineInk.pageIdOf("orig-c.md")).toBe(SHARED);
		expect(inlineInk.isLoaded("orig-c.md")).toBe(false);

		// Remembered-owner repair of the copy runs meanwhile.
		await r.resolve("copy-c.md", SHARED, "orig-c.md");
		const newId = r.indexed.get("copy-c.md")!;
		expect(r.sidecarIds(newId)).toEqual(["orig-1", "orig-2", "orig-3"]); // clone ok

		// The owner's read lands.
		r.fake.release();
		await ownerLoad;
		expect(inlineInk.strokes("orig-c.md").map((s) => s.id)).toEqual(["orig-1", "orig-2", "orig-3"]);

		await drain();

		// Readout: every file on disk (shows whether a conflict copy was kept).
		console.log("[InlineStore-1 owner] files:", [...r.fake.files.keys()].sort().join(", "));
		// CORRECT: the original note's sidecar on disk still holds its ink.
		expect(r.sidecarIds(SHARED)).toEqual(["orig-1", "orig-2", "orig-3"]);
	});
});
