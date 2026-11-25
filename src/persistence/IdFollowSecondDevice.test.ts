/**
 * TWO DEVICES, AN ID EDIT FOLLOWED ON THE SECOND DEVICE. Notes O (the owner) and C (its copy) carry one id on both
 * devices. On the first device O's id value is edited: O's ink file moves to the new id, C is left alone on the old id,
 * and C saves what it shows (its strokes drawn while locked with them) under the old id. The sync then brings three
 * writes to the second device: O's frontmatter naming the new id, the new id's ink file, and C's file under the old id.
 *
 * This is the second device's view: O's ink loaded on the old id (opened there earlier), C locked as its copy, its ink
 * loaded too. The three writes land in each order, inside the grace O's frontmatter change starts, then the grace runs
 * out and the second device follows O's edit itself. Wanted in every order: C's file stays under the old id, and the new
 * id's file stays O's.
 *
 * A known limit in every order (it.fails), the after-release row TWO-DEVICE-ID-FOLLOW. The second device's move sets C's
 * file beside the new id as a listed copy (the new id's file is there already), and C, left alone on the old id, finds
 * no file at its lift and saves what it shows on this device under the old id. C's strokes drawn on the first device
 * while it was locked are kept, in the listed copy against O's new id, and no longer under C's id. The new id's file
 * stays O's.
 *
 * Real pieces: the identity check, the declaim grace, followEditedId and its move (PageIdentity), inline ink, PageStore.
 * Synthetic: FakeAdapter, note metadata from an in-memory map, the sync's writes as outside writes to the adapter, the
 * frontmatter change heard by a direct identity check (the metadata "changed" handler's call). Inline ink only, no
 * Slides file. Not device acceptance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { FakeAdapter } from "./FakeAdapter";
import { PageStore } from "./PageStore";
import type { InkStroke } from "../ink/Stroke";

const O = "Original.md";
const C = "Original 1.md";
const X = "shared-id";
const Y = "edited-id";
const OLD_FILE = `.handwriting/${X}.json`;
const NEW_FILE = `.handwriting/${Y}.json`;

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

/** An inline page under `id` holding these strokes, as the first device wrote it. */
function pageText(id: string, strokeIds: string[]): string {
	const page = emptyPage(id);
	page.surface = "inline";
	page.strokes = strokeIds.map((s, i) => stroke(s, 5 + 30 * i));
	return serializePage(page);
}

/** The second device: O and C on the old id, the old id's file holding p0, the census run. */
function rig() {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never);
	fake.files.set(OLD_FILE, pageText(X, ["p0"]));
	const paths = [O, C];
	const files = new Map<string, TFile>();
	for (const path of paths) files.set(path, Object.assign(new TFile(), { path, extension: "md", basename: path.slice(0, -3) }));
	const idOf = new Map<string, string>(paths.map((p) => [p, X]));
	const cache = (path: string) => (files.has(path) ? { frontmatter: { "handwriting-page-id": idOf.get(path) }, sections: [{ type: "yaml" }] } : null);
	const saves: string[] = [];
	const plugin: any = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		pageIdWatchReady: true,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		pendingRecycle: new Map(),
		declaimTimers: new Map(),
		declaimedPaths: new Set(),
		settings: { pageOwners: {}, cameras: {} },
		settingsDirty: false,
		settingsTimer: null,
		flushSettings: async () => undefined,
		store,
		app: {
			vault: {
				adapter: fake,
				getFileByPath: (p: string) => files.get(p) ?? null,
				getAbstractFileByPath: (p: string) => files.get(p) ?? null,
				getMarkdownFiles: () => [...files.values()],
				getFiles: () => [...files.values()],
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
		scheduleSidecar: (pageId, page) => {
			saves.push(pageId);
			store.schedule(pageId, page);
		},
		scheduleSidecarNow: (pageId, page) => {
			saves.push(pageId);
			return store.saveNow(pageId, page);
		},
		notify: () => undefined,
	};
	inlineInk.attachHost(host);
	/** The stroke ids in a live ink file, or null when there is none. */
	const fileIds = (path: string, id: string): string[] | null => {
		const t = fake.files.get(path);
		return t === undefined ? null : ids(parsePage(t, id).data.strokes).sort();
	};
	/** Every ink file holding stroke `id`, trash left out. */
	const filesWith = (id: string): string[] => {
		const out: string[] = [];
		for (const [k, t] of fake.files) {
			if (!k.startsWith(".handwriting/") || !k.endsWith(".json") || k.includes("trash")) continue;
			if (ids(parsePage(t, k.slice(13, -5)).data.strokes).includes(id)) out.push(k);
		}
		return out.sort();
	};
	const drain = async (): Promise<void> => {
		for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(2000);
		await store.flush();
		for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(2000);
	};
	return { plugin, fake, store, saves, idOf, fileIds, filesWith, drain };
}

/**
 * The sync's three writes from the first device, after its own move and C's save there:
 * - frontmatter: O's id line names the new id, as the cache indexes it, and the change is heard;
 * - new id: the new id's ink file, O's page as the first device's move made it;
 * - copy: C's file under the old id, the shared stroke and c1, drawn on C there while it was locked.
 */
type Write = "frontmatter" | "new id" | "copy";
const WRITES: Write[] = ["frontmatter", "new id", "copy"];

function orders(list: Write[]): Write[][] {
	if (list.length <= 1) return [list];
	return list.flatMap((w) => orders(list.filter((v) => v !== w)).map((rest) => [w, ...rest]));
}

function land(r: ReturnType<typeof rig>, w: Write): void {
	if (w === "frontmatter") {
		r.idOf.set(O, Y);
		r.plugin.checkPageIdentity(O);
	} else if (w === "new id") {
		r.fake.externalWrite(NEW_FILE, pageText(Y, ["p0"]));
	} else {
		r.fake.externalWrite(OLD_FILE, pageText(X, ["p0", "c1"]));
	}
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	for (const p of [O, C]) inlineInk.handleDelete(p);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("the second device follows an id edit made on the first, the sync's writes in each order", () => {
	it.fails.each(orders(WRITES).map((o) => [o.join(", then "), o] as const))("%s, then the grace: the copy's file stays under the old id (a known limit, TWO-DEVICE-ID-FOLLOW)", async (_name, order) => {
		const r = rig();
		r.plugin.pageIds.claimOwnership(X, O);
		inlineInk.markDuplicateLocked(C, O);
		await inlineInk.ensureLoaded(O);
		await inlineInk.ensureLoaded(C);
		expect(r.plugin.pageIds.owner(X), "precondition: O owns the old id").toBe(O);
		expect(inlineInk.pageIdOf(O), "precondition: O's ink is loaded on the old id").toBe(X);
		expect(inlineInk.isDuplicateLocked(C), "precondition: C is locked").toBe(true);
		expect(ids(inlineInk.strokes(C)), "precondition: C shows the shared stroke").toEqual(["p0"]);

		const moved: string[] = [];
		const real = r.store.keepAsideUnder.bind(r.store);
		vi.spyOn(r.store, "keepAsideUnder").mockImplementation(async (from, to, own, named) => {
			const out = await real(from, to, own, named);
			moved.push(`${from} ${out.kind}${out.kind === "moved" ? ` to ${out.to}` : ""}`);
			return out;
		});

		for (const w of order) {
			land(r, w);
			await vi.advanceTimersByTimeAsync(500);
		}
		expect(moved, "precondition: the follow ran before the last write landed").toEqual([]);
		expect(r.fileIds(OLD_FILE, X), "precondition: the copy's file landed under the old id").toEqual(["c1", "p0"]);

		await r.drain();
		await r.drain();

		expect(inlineInk.pageIdOf(O), "precondition: O did not follow its new id").toBe(Y);
		expect.soft(r.fileIds(OLD_FILE, X), `the copy's file was taken from under the old id (moves: ${moved.join("; ") || "none"}; c1 now in: ${r.filesWith("c1").join(", ") || "no file"})`).toEqual(["c1", "p0"]);
		expect.soft(r.fileIds(NEW_FILE, Y), "the new id's file is not O's page").toEqual(["p0"]);
		expect.soft(r.filesWith("c1"), "the copy's stroke c1 sits in a file other than the old id's").toEqual([OLD_FILE]);
	});
});
