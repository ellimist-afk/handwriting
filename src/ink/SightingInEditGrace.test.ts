/**
 * A LOCKED COPY SEEN WHILE THE OWNER'S ID LINE IS UNREADABLE.
 *
 * The id's owner empties its id line (a backspace before a new value, or the line deleted), which arms its grace. A copy
 * locked on the id has its own metadata change heard meanwhile (its body edited), inside the grace or before the owner's
 * change is heard. The sighting does not change where the owner's grace ends: as with no sighting, the owner back on the
 * id leaves the copy locked and keeps the id; the owner on another id moves its files, then the notes left are counted
 * and the copy is unlocked and owns the old id; the owner's line still empty frees the id and the copy is given it.
 *
 * Pins: each of the three ends with no sighting.
 *
 * Real InlineInkStore (the plugin's), real PageStore over FakeAdapter, the real identity handlers on a plugin built
 * without its constructor, as in DeleteInEditGrace.test.ts; the vault's process rewrites the id line the cache answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkStroke } from "./Stroke";

const N = "Original.md";
const C = "Original 1.md";
const X = "shared-id";
const Y = "edited-id";
const FILE = `.handwriting/${X}.json`;
const RESOLVED = "Handwriting: duplicate resolved. Ink on this note saves again.";

function stroke(id: string, x = 10): InkStroke {
	return {
		id,
		color: "#000",
		width: 2,
		tool: "pen",
		points: [
			{ x, y: 10, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: x - 2, y: 8, width: 16, height: 16 },
		createdAt: 1,
	} as InkStroke;
}

const ids = (list: readonly { id: string }[]): string[] => list.map((s) => s.id);

/** N and C carry the shared id, whose file holds p0. The cache answers each note's id line as it is now. */
function rig() {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const shared = emptyPage(X);
	shared.surface = "inline";
	shared.strokes = [stroke("p0", 5)];
	fake.files.set(FILE, serializePage(shared));
	const paths = [N, C];
	const files = new Map<string, TFile>();
	for (const path of paths) files.set(path, Object.assign(new TFile(), { path, extension: "md", basename: path.slice(0, -3) }));
	const listed = new Set(paths);
	const idOf = new Map<string, string>(paths.map((p) => [p, X]));
	const cache = (path: string) => (listed.has(path) ? { frontmatter: { "handwriting-page-id": idOf.get(path) }, sections: [{ type: "yaml" }] } : null);
	const notices: string[] = [];
	const plugin: any = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		pageIdWatchReady: false,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		pendingRecycle: new Map(),
		declaimTimers: new Map(),
		declaimedPaths: new Set(),
		resolvingDuplicates: new Set(),
		settings: { pageOwners: {}, cameras: {} },
		settingsDirty: false,
		settingsTimer: null,
		flushSettings: async () => undefined,
		store,
		app: {
			vault: {
				adapter: fake,
				getFileByPath: (p: string) => (listed.has(p) ? files.get(p)! : null),
				getAbstractFileByPath: (p: string) => (listed.has(p) ? files.get(p)! : null),
				getMarkdownFiles: () => [...listed].map((p) => files.get(p)!),
				getFiles: () => [...listed].map((p) => files.get(p)!),
				// The note's text as its id line stands; the id line the rewrite leaves is what the cache answers next.
				process: async (f: TFile, fn: (data: string) => string): Promise<string> => {
					const now = idOf.get(f.path);
					const out = fn(now === undefined ? "body\n" : `---\nhandwriting-page-id: ${now}\n---\nbody\n`);
					const m = /handwriting-page-id:\s*(\S+)/.exec(out);
					if (m) idOf.set(f.path, m[1]!);
					else idOf.delete(f.path);
					return out;
				},
			},
			metadataCache: {
				getCache: (p: string) => cache(p),
				getFileCache: (f: { path: string }) => cache(f.path),
			},
		},
	});
	const host: InlineInkHost = {
		readPageId: (path) => plugin.notePageId(path),
		claimId: (path, proposedId) => plugin.claimNotePageId(path, proposedId),
		loadSidecar: async (pageId) => store.load(pageId),
		scheduleSidecar: (pageId, page) => store.schedule(pageId, page),
		scheduleSidecarNow: (pageId, page) => store.saveNow(pageId, page),
		notify: (m) => void notices.push(m),
	};
	inlineInk.attachHost(host);
	const onDisk = (): string[] | null => {
		const t = fake.files.get(FILE);
		return t === undefined ? null : ids(parsePage(t, X).data.strokes);
	};
	const drain = async (): Promise<void> => {
		for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(2000);
		await store.flush();
		for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(2000);
	};
	const setId = (path: string, id: string): void => void idOf.set(path, id);
	const clearId = (path: string): void => void idOf.delete(path);
	/** The id line the cache answers for `path` now. */
	const lineOf = (path: string): string | undefined => plugin.recentPageIdFor(files.get(path)!);
	const told = (): number => notices.filter((n) => n === RESOLVED).length;
	return { plugin, fake, store, onDisk, drain, setId, clearId, lineOf, told };
}

type Rig = ReturnType<typeof rig>;

/** N owns the id; C is locked as its copy, its ink loaded, a stroke c1 drawn on it and refused; `ownerLoaded`: N's ink too. */
async function ownerAndLockedCopy(r: Rig, ownerLoaded: boolean): Promise<void> {
	r.plugin.pageIds.claimOwnership(X, N);
	inlineInk.markDuplicateLocked(C, N);
	if (ownerLoaded) await inlineInk.ensureLoaded(N);
	await inlineInk.ensureLoaded(C);
	expect(r.plugin.pageIds.owner(X), "precondition: N owns the id").toBe(N);
	expect(inlineInk.isDuplicateLocked(C), "precondition: C is locked").toBe(true);
	inlineInk.commit(C, stroke("c1", 70));
	await r.drain();
	expect(r.onDisk(), "precondition: the lock refused the save").toEqual(["p0"]);
}

/** The stroke ids in the new id's ink file, or none. */
const editedFileIds = (r: Rig): string[] => {
	const t = r.fake.files.get(`.handwriting/${Y}.json`);
	return t === undefined ? [] : ids(parsePage(t, Y).data.strokes);
};

/** Watches the owner's file move: C unlocked or the id not N's at any step is noted. */
function watchMove(r: Rig): () => { steps: number; seen: string[] } {
	const seen: string[] = [];
	let steps = 0;
	const look = (when: string): void => {
		if (!inlineInk.isDuplicateLocked(C)) seen.push(`${C} unlocked ${when}`);
		const owner = r.plugin.pageIds.owner(X);
		if (owner !== N) seen.push(`the id was ${owner ?? "nobody"}'s ${when}`);
	};
	const real = r.store.keepAsideUnder.bind(r.store);
	vi.spyOn(r.store, "keepAsideUnder").mockImplementation(async (from, to, own, named) => {
		steps++;
		look(`as ${from} began to move`);
		const out = await real(from, to, own, named);
		look(`as ${from} finished moving`);
		return out;
	});
	return () => ({ steps, seen });
}

type End = "back on the id" | "on another id" | "still unreadable";
type Sighting = "none" | "inside the grace" | "before the owner's change is heard";

/** N's id line emptied; C's metadata change heard (or not) as `sighting` says; then N's line ends as `end` says. */
async function run(r: Rig, sighting: Sighting, end: End): Promise<void> {
	r.clearId(N);
	if (sighting === "before the owner's change is heard") r.plugin.checkPageIdentity(C);
	r.plugin.checkPageIdentity(N);
	await vi.advanceTimersByTimeAsync(1000);
	if (sighting === "inside the grace") r.plugin.checkPageIdentity(C);
	await vi.advanceTimersByTimeAsync(1000);
	if (end !== "still unreadable") {
		r.setId(N, end === "back on the id" ? X : Y);
		r.plugin.checkPageIdentity(N);
	}
	await r.drain();
	await r.drain();
}

/** Where each end leaves every note with no sighting (pinned below). Every want is soft. */
function ends(r: Rig, end: End, ownerLoaded: boolean, moves: () => { steps: number; seen: string[] }): void {
	if (end === "back on the id") {
		expect.soft(r.plugin.pageIds.owner(X), "the id passed from the owner while its line was empty").toBe(N);
		expect.soft(r.lineOf(N), "the owner, back on its id, was given another id as a copy").toBe(X);
		expect.soft(inlineInk.isDuplicateLocked(C), "the copy was unlocked though the owner is back on the id").toBe(true);
		expect.soft(r.onDisk(), "the shared file changed").toEqual(["p0"]);
		if (ownerLoaded) {
			expect.soft(inlineInk.pageIdOf(N), "the owner's record left the id").toBe(X);
			expect.soft(ids(inlineInk.strokes(N)), "the owner does not show its ink").toEqual(["p0"]);
		}
		return;
	}
	expect.soft(inlineInk.isDuplicateLocked(C), "the copy left alone on the old id is still locked").toBe(false);
	expect.soft(r.plugin.pageIds.owner(X), "the copy left alone on the old id does not own it").toBe(C);
	expect.soft(r.told(), "the lift is not told once").toBe(1);
	expect.soft(ids(inlineInk.strokes(C)).sort(), "the copy does not show the shared stroke and its own").toEqual(["c1", "p0"]);
	expect.soft(r.onDisk()?.sort(), "the old id's file does not hold the copy's page").toEqual(["c1", "p0"]);
	if (end === "still unreadable") {
		expect.soft(r.plugin.pageIds.idsOf(N), "the owner still owns an id").toEqual([]);
		return;
	}
	expect.soft(r.plugin.pageIds.owner(Y), "the owner does not own its new id").toBe(N);
	if (!ownerLoaded) {
		expect.soft(editedFileIds(r), "a file landed under the owner's new id though its ink was not loaded").toEqual([]);
		return;
	}
	expect.soft(moves().steps, "the owner's files did not move to its new id").toBeGreaterThan(0);
	expect.soft(moves().seen, "the copy was unlocked or given the id while the owner's files moved").toEqual([]);
	expect.soft(editedFileIds(r), "the owner's ink is not under its new id, or a stroke of the copy went with it").toEqual(["p0"]);
	expect.soft(ids(inlineInk.strokes(N)), "the owner does not show its ink: it opens blank").toEqual(["p0"]);
	expect.soft(inlineInk.pageIdOf(N), "the owner's record is not on its new id").toBe(Y);
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.useRealTimers();
	for (const p of [N, C]) inlineInk.handleDelete(p);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const CASES: { end: End; loaded: boolean }[] = [
	{ end: "back on the id", loaded: true },
	{ end: "on another id", loaded: true },
	{ end: "on another id", loaded: false },
	{ end: "still unreadable", loaded: true },
];

describe.each(["none", "inside the grace", "before the owner's change is heard"] as Sighting[])("the owner's id line emptied beside a locked copy, the copy seen: %s", (sighting) => {
	it.each(CASES)("then $end (the owner's ink loaded $loaded), it ends as with no sighting", async ({ end, loaded }) => {
		const r = rig();
		await ownerAndLockedCopy(r, loaded);
		const moves = watchMove(r);

		await run(r, sighting, end);

		ends(r, end, loaded, moves);
	});
});
