/**
 * Late async result: a duplicate copy renamed, deleted or named again while
 * its repair is in flight.
 *
 * resolveDuplicate (main.ts:4752) captures `copyPath` before two awaits -
 * the sidecar clone (store.clone) and the frontmatter rewrite
 * (vault.process). A rename landing in that gap moves the copy's live
 * record to the new path (inlineInk.handleRename, main.ts:4241), and
 * vault.process follows the TFile, so the new id is written into the
 * renamed note. After the awaits, pageIds.register and
 * inlineInk.reassignPage still use the OLD path: reassignPage finds no
 * record there, and the renamed copy's live record keeps the SHARED id, so
 * its new strokes save into the original note's ink file.
 *
 * Rig: real resolveDuplicate on a minimal `this`, real PageStore over
 * FakeAdapter, real inlineInk store, with TFile objects that follow a rename
 * the way Obsidian's do. The fake vault.process rejects for a note that is no
 * longer there, as Obsidian's does when its read of the file fails.
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
	/** Every path pageIds.register was called with, in order. */
	registered: string[];
	notes: Map<string, string>;
	indexed: Map<string, string | null>;
	resolve: (copyPath: string, id: string, ownerPath: string) => Promise<void>;
	/** Obsidian's rename: the TFile keeps its identity and takes the new path. */
	rename: (from: string, to: string) => void;
	/** The note is deleted: its file is gone from the vault. */
	remove: (path: string) => void;
}

function rig(): Rig {
	const fake = new GatedAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
	const notes = new Map<string, string>();
	const indexed = new Map<string, string | null>();
	const registered: string[] = [];
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
		pageIds: {
			register: (p: string) => {
				registered.push(p);
				return { kind: "registered" };
			},
			snapshot: () => ({}),
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
		// main.ts:4233, the vault "rename" handler.
		inlineInk.handleRename(from, to);
	};
	const remove = (path: string): void => {
		files.delete(path);
		notes.delete(path);
		indexed.delete(path);
	};
	return { fake, store, registered, notes, indexed, resolve, rename, remove };
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

describe("late async: a duplicate copy renamed while its repair awaits", () => {
	it("control: no rename, the copy's live record takes the new id", async () => {
		const r = rig();
		const SHARED = "late-shared-a";
		const LIVE = `.handwriting/${SHARED}.json`;
		r.fake.files.set(LIVE, inlineBytes(SHARED, ["orig-1"]));
		r.fake.mtimes.set(LIVE, 42);
		r.notes.set("late-orig-a.md", note(SHARED));
		r.notes.set("late-copy-a.md", note(SHARED));
		r.indexed.set("late-orig-a.md", SHARED);
		r.indexed.set("late-copy-a.md", SHARED);
		await inlineInk.ensureLoaded("late-copy-a.md");
		expect(inlineInk.pageIdOf("late-copy-a.md")).toBe(SHARED);

		await r.resolve("late-copy-a.md", SHARED, "late-orig-a.md");
		const newId = r.indexed.get("late-copy-a.md")!;
		expect(newId).not.toBe(SHARED);
		expect(inlineInk.pageIdOf("late-copy-a.md")).toBe(newId);
	});

	it("renamed during the sidecar clone: the renamed copy's live record takes the new id", async () => {
		const r = rig();
		const SHARED = "late-shared-b";
		const LIVE = `.handwriting/${SHARED}.json`;
		r.fake.files.set(LIVE, inlineBytes(SHARED, ["orig-1"]));
		r.fake.mtimes.set(LIVE, 42);
		r.notes.set("late-orig-b.md", note(SHARED));
		r.notes.set("late-copy-b.md", note(SHARED));
		r.indexed.set("late-orig-b.md", SHARED);
		r.indexed.set("late-copy-b.md", SHARED);
		// The copy is open: its record is loaded under the shared id.
		await inlineInk.ensureLoaded("late-copy-b.md");
		expect(inlineInk.pageIdOf("late-copy-b.md")).toBe(SHARED);

		// The clone's read of the shared sidecar is held; the user renames the copy meanwhile.
		r.fake.armGate(LIVE);
		const repair = r.resolve("late-copy-b.md", SHARED, "late-orig-b.md");
		for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
		r.rename("late-copy-b.md", "late-renamed-b.md");
		expect(inlineInk.pageIdOf("late-renamed-b.md"), "the rename did not move the live record").toBe(SHARED);
		r.fake.release();
		await repair;

		const newId = r.indexed.get("late-renamed-b.md")!;
		// Precondition: the frontmatter rewrite followed the file to its new path.
		expect(newId, "the renamed note never got a fresh id").not.toBe(SHARED);
		// CORRECT: the open copy now writes under its own id, not the original's.
		expect(
			inlineInk.pageIdOf("late-renamed-b.md"),
			"the renamed copy still saves into the original note's ink file"
		).toBe(newId);
	});

	it("renamed while the clone answers that the new ink file exists: the renamed copy is locked, the old path is not", async () => {
		const r = rig();
		const SHARED = "late-shared-c";
		const LIVE = `.handwriting/${SHARED}.json`;
		r.fake.files.set(LIVE, inlineBytes(SHARED, ["orig-1"]));
		r.fake.mtimes.set(LIVE, 42);
		r.notes.set("late-orig-c.md", note(SHARED));
		r.notes.set("late-copy-c.md", note(SHARED));
		r.indexed.set("late-orig-c.md", SHARED);
		r.indexed.set("late-copy-c.md", SHARED);
		await inlineInk.ensureLoaded("late-copy-c.md");

		let answer: (v: "exists") => void = () => {};
		vi.spyOn(r.store, "clone").mockImplementation(() => new Promise((res) => (answer = res)));
		const repair = r.resolve("late-copy-c.md", SHARED, "late-orig-c.md");
		for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
		r.rename("late-copy-c.md", "late-renamed-c.md");
		answer("exists");
		await repair;

		expect(inlineInk.isDuplicateLocked("late-renamed-c.md"), "the renamed copy was left unlocked").toBe(true);
		expect(inlineInk.isDuplicateLocked("late-copy-c.md"), "the lock went to the path the copy left").toBe(false);
		expect(r.registered).toEqual([]);
	});

	it("deleted during the sidecar clone: the repair rejects at the frontmatter rewrite and registers nothing", async () => {
		const r = rig();
		const SHARED = "late-shared-d";
		const LIVE = `.handwriting/${SHARED}.json`;
		r.fake.files.set(LIVE, inlineBytes(SHARED, ["orig-1"]));
		r.fake.mtimes.set(LIVE, 42);
		r.notes.set("late-orig-d.md", note(SHARED));
		r.notes.set("late-copy-d.md", note(SHARED));
		r.indexed.set("late-orig-d.md", SHARED);
		r.indexed.set("late-copy-d.md", SHARED);
		await inlineInk.ensureLoaded("late-copy-d.md");

		r.fake.armGate(LIVE);
		const repair = r.resolve("late-copy-d.md", SHARED, "late-orig-d.md");
		for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
		r.remove("late-copy-d.md");
		r.fake.release();

		// As today: vault.process is not caught inside resolveDuplicate, so the
		// method rejects. Both callers hand it to runDetached (main.ts:4535 and
		// main.ts:4711), which catches and logs it.
		await expect(repair).rejects.toThrow("ENOENT");
		expect(r.registered).toEqual([]);
		expect(inlineInk.pageIdOf("late-copy-d.md")).toBe(SHARED);
		expect(r.notes.get("late-orig-d.md")).toBe(note(SHARED));
	});

	it("named again by its new path while the first repair awaits: one clone and one new id", async () => {
		const r = rig();
		const SHARED = "late-shared-e";
		const LIVE = `.handwriting/${SHARED}.json`;
		r.fake.files.set(LIVE, inlineBytes(SHARED, ["orig-1"]));
		r.fake.mtimes.set(LIVE, 42);
		r.notes.set("late-orig-e.md", note(SHARED));
		r.notes.set("late-copy-e.md", note(SHARED));
		r.indexed.set("late-orig-e.md", SHARED);
		r.indexed.set("late-copy-e.md", SHARED);
		await inlineInk.ensureLoaded("late-copy-e.md");
		const clone = vi.spyOn(r.store, "clone");

		r.fake.armGate(LIVE);
		const first = r.resolve("late-copy-e.md", SHARED, "late-orig-e.md");
		for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
		r.rename("late-copy-e.md", "late-renamed-e.md");
		// The same note, named by the path it has now, while the first repair waits.
		const second = r.resolve("late-renamed-e.md", SHARED, "late-orig-e.md");
		for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
		r.fake.release();
		await Promise.all([first, second]);

		const { slidesSidecarId } = await import("../slides/SlidesInkSurface");
		expect(clone.mock.calls.filter(([source]) => source === SHARED), "the page ink was cloned once per repair").toHaveLength(1);
		expect(clone.mock.calls.filter(([source]) => source === slidesSidecarId(SHARED)), "the slides ink was cloned once per repair").toHaveLength(1);
		expect(r.registered, "the copy was given an id more than once").toHaveLength(1);
		const newId = r.indexed.get("late-renamed-e.md")!;
		expect(newId).not.toBe(SHARED);
		expect(inlineInk.pageIdOf("late-renamed-e.md")).toBe(newId);
	});
});
