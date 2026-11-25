/**
 * A note and its copy carry the same page id, and only the copy is duplicate-locked. Both are open on the shared page:
 * stroke A, then stroke B drawn across A. On the copy, while locked, the eraser cuts A where B does not cross it, so A's
 * pieces stand where A stood, under B. The original is deleted and the delete's clear reads the shared file again and
 * saves the copy's own changes over it.
 *
 * After the clear each piece stands where the stroke it was cut from stands in the file's order, under B, in the order
 * the cut left them, and the file keeps that order. A piece cut again goes where its first source stands. A stroke drawn
 * on the copy goes on top. A stroke erased whole stays erased, a cut undone leaves the file's order, and a piece whose
 * source the file no longer holds goes after the file's strokes. A copy renamed while the clear reads the file keeps each
 * piece once, in that place, and saves it under its new path.
 *
 * Real InlineInkStore (the plugin's), real PageStore over FakeAdapter, the real delete handler on a plugin built without
 * its constructor, and the real eraser (eraseAt) on a bare overlay with the partial eraser on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import HandwritingPlugin from "../main";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import { StrokeIndex } from "../ink/StrokeIndex";
import type { InkStroke } from "../ink/Stroke";

const N = "Original.md";
const C = "Original 1.md";
const R = "Renamed copy.md";
const X = "shared-id";
const FILE = `.handwriting/${X}.json`;

/** A straight stroke from (x0, y0) to (x1, y1), a point every 2 px. */
function line(id: string, x0: number, y0: number, x1: number, y1: number, color = "#000000"): InkStroke {
	const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / 2;
	const points = [];
	for (let i = 0; i <= n; i++) points.push({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n, pressure: 0.5, t: i });
	return {
		id, tool: "pen", color, width: 2, points,
		bbox: { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) }, createdAt: 0,
	};
}

/** A: across the page at y 100. B: down the page at x 150, across A. D: far below both. */
const A = (): InkStroke => line("A", 0, 100, 200, 100);
const B = (): InkStroke => line("B", 150, 40, 150, 160, "#ff0000");
const D = (): InkStroke => line("D", 0, 400, 100, 400, "#0000ff");

/**
 * A stroke named by where it lies, the rest by id (piece ids are generated). A's pieces by where they start: A-0 from
 * the page's left edge, A-74 from just right of the first cut (x 60), A-124 from just right of the second (x 110).
 */
function name(s: InkStroke): string {
	if (s.id.length === 1) return s.id;
	if (s.points.some((p) => p.y !== 100)) return "?" + s.id;
	const left = Math.min(...s.points.map((p) => p.x));
	return left < 30 ? "A-0" : left < 100 ? "A-74" : "A-124";
}
const names = (list: readonly InkStroke[]): string[] => list.map(name);

/**
 * Two notes on one id, the shared file holding A then B. Saves and file reads are counted as the store is asked for them.
 * `hold` keeps every file read waiting until `release`.
 */
function rig() {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const shared = emptyPage(X);
	shared.surface = "inline";
	shared.strokes = [A(), B()];
	fake.files.set(FILE, serializePage(shared));
	let gate: Promise<void> | null = null;
	let open = (): void => undefined;
	const reads: string[] = [];
	const files = new Map<string, TFile>();
	for (const path of [N, C]) files.set(path, Object.assign(new TFile(), { path, extension: "md", basename: path.slice(0, -3) }));
	const listed = new Set([N, C]);
	const cache = (path: string) => (files.has(path) ? { frontmatter: { "handwriting-page-id": X }, sections: [{ type: "yaml" }] } : null);
	const saves: string[] = [];
	const plugin: any = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		pageIdWatchReady: false,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		settings: { pageOwners: {}, cameras: {} },
		store,
		app: {
			vault: {
				adapter: fake,
				getFileByPath: (p: string) => (listed.has(p) ? files.get(p)! : null),
				getAbstractFileByPath: (p: string) => (listed.has(p) ? files.get(p)! : null),
				getMarkdownFiles: () => [...listed].map((p) => files.get(p)!),
				getFiles: () => [...listed].map((p) => files.get(p)!),
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
		loadSidecar: async (pageId) => {
			reads.push(pageId);
			if (gate) await gate;
			return store.load(pageId);
		},
		scheduleSidecar: (pageId, page) => {
			saves.push(pageId);
			store.schedule(pageId, page);
		},
		scheduleSidecarNow: (pageId, page) => {
			saves.push(pageId);
			return store.saveNow(pageId, page);
		},
		sidecarLanded: (page) => store.hasLanded(page),
		notify: () => undefined,
	};
	inlineInk.attachHost(host);
	const onDisk = (): string[] => {
		const t = fake.files.get(FILE);
		return t === undefined ? [] : names(parsePage(t, X).data.strokes);
	};
	/** The original is deleted: the plugin's delete handler, then the inline store's, as Obsidian calls them. */
	const deleteOriginal = async (): Promise<void> => {
		listed.delete(N);
		const handled = plugin.onFileDeleted(files.get(N));
		inlineInk.handleDelete(N);
		await handled;
	};
	/** A Markdown note renamed: the vault lists it under the new path, and the inline store moves its record. */
	const rename = (from: string, to: string): void => {
		const f = files.get(from)!;
		files.delete(from);
		listed.delete(from);
		f.path = to;
		f.basename = to.slice(0, -3);
		files.set(to, f);
		listed.add(to);
		inlineInk.handleRename(from, to);
	};
	const hold = (): void => {
		gate = new Promise<void>((r) => (open = r));
	};
	const release = (): void => {
		gate = null;
		open();
	};
	const drain = async (): Promise<void> => {
		for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(2000);
		await store.flush();
		for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(2000);
	};
	return { store, saves, reads, onDisk, deleteOriginal, rename, hold, release, drain };
}

/**
 * One eraser gesture on the copy through the real eraseAt (ring 14 px at scale 1), on a bare overlay: partial unless
 * `whole`. Returns what history keeps of it: the strokes taken, with their indices.
 */
function erase(at: { x: number; y: number }, whole = false): Array<{ stroke: InkStroke; index: number }> {
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	view.mode = "erase";
	view.scale = 1;
	view.eraseWhole = whole;
	view.erased = [];
	view.erasePieces = new Set<string>();
	view.strokeIndex = new StrokeIndex();
	view.indexDirty = true;
	view.damage = { addRect: () => undefined, addAll: () => undefined };
	view.camera = { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) };
	view.filePath = () => C;
	view.repaintPath = () => undefined;
	view.scheduleRepaint = () => undefined;
	const proto = InkOverlayPlugin.prototype as unknown as { eraseAt(this: unknown, sample: unknown): void };
	proto.eraseAt.call(view, { ...at, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
	return view.erased as Array<{ stroke: InkStroke; index: number }>;
}

/** The copy locked alone, as a failed repair leaves it; both notes open on the shared page. */
async function lockedCopyOpen(): Promise<void> {
	inlineInk.markDuplicateLocked(C, N);
	await inlineInk.ensureLoaded(C);
	await inlineInk.ensureLoaded(N);
	expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
	expect(names(inlineInk.strokes(C)), "precondition: the copy loaded the shared page").toEqual(["A", "B"]);
}

/** The lock clears on the original's delete; then everything queued is flushed. */
async function clear(r: ReturnType<typeof rig>): Promise<void> {
	await r.deleteOriginal();
	await r.drain();
	expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	inlineInk.handleDelete(N);
	inlineInk.handleDelete(C);
	inlineInk.handleDelete(R);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("pieces a locked copy cut keep their place under the strokes that cross them when the lock clears", () => {
	it("A cut in the middle on the locked copy: after the clear its pieces stand under B, in the copy and in the file", async () => {
		const r = rig();
		await lockedCopyOpen();
		erase({ x: 60, y: 100 });
		const cut = names(inlineInk.strokes(C));
		expect(cut, "precondition: the cut left A's two pieces where A stood, under B").toEqual(["A-0", "A-74", "B"]);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "the cut pieces moved above the stroke drawn across them").toEqual(cut);
		expect(r.onDisk(), "the file holds the cut pieces above the stroke drawn across them").toEqual(cut);
	});

	it("a piece cut again stands where the stroke it first came from stands, with every piece in the order the cuts left", async () => {
		const r = rig();
		await lockedCopyOpen();
		erase({ x: 60, y: 100 });
		erase({ x: 110, y: 100 });
		const cut = names(inlineInk.strokes(C));
		expect(cut, "precondition: two cuts left three pieces of A under B").toEqual(["A-0", "A-74", "A-124", "B"]);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "a piece cut again moved above the stroke drawn across it").toEqual(cut);
		expect(r.onDisk(), "the file holds a piece cut again above the stroke drawn across it").toEqual(cut);
	});

	it("a stroke drawn on the locked copy goes on top, above B, with A's pieces still under B", async () => {
		const r = rig();
		await lockedCopyOpen();
		erase({ x: 60, y: 100 });
		inlineInk.commit(C, D());

		await clear(r);

		expect(names(inlineInk.strokes(C)), "the pieces moved, or the new stroke is not on top").toEqual(["A-0", "A-74", "B", "D"]);
		expect(r.onDisk(), "the file's order is not the copy's").toEqual(["A-0", "A-74", "B", "D"]);
	});

	it("A erased whole on the locked copy stays erased after the clear", async () => {
		const r = rig();
		await lockedCopyOpen();
		erase({ x: 60, y: 100 }, true);
		expect(names(inlineInk.strokes(C)), "precondition: the whole eraser took A").toEqual(["B"]);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "a stroke erased whole came back").toEqual(["B"]);
		expect(r.onDisk(), "the file still holds a stroke erased whole").toEqual(["B"]);
	});

	it("a cut undone on the locked copy leaves the file's order after the clear", async () => {
		const r = rig();
		await lockedCopyOpen();
		const taken = erase({ x: 60, y: 100 });
		const pieces = inlineInk.strokes(C).filter((s) => s.id.length > 1).map((s) => s.id);
		// The gesture's replace op as history undoes it: the pieces out, the original back at its index.
		inlineInk.takeLive(C, pieces);
		inlineInk.applyAddLive(C, taken.map((e) => e.stroke), taken.map((e) => e.index));
		expect(names(inlineInk.strokes(C)), "precondition: the undo put A back under B").toEqual(["A", "B"]);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "an undone cut changed the order").toEqual(["A", "B"]);
		expect(r.onDisk(), "an undone cut changed the file's order").toEqual(["A", "B"]);
	});

	it("pieces of a stroke the original erased meanwhile go after the file's strokes, as before", async () => {
		const r = rig();
		await lockedCopyOpen();
		erase({ x: 60, y: 100 });
		inlineInk.applyRemove(N, ["A"]);
		await r.drain();
		expect(r.onDisk(), "precondition: the original's erase of A reached the file").toEqual(["B"]);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "pieces of a stroke gone from the file did not follow the file's strokes").toEqual(["B", "A-0", "A-74"]);
		expect(r.onDisk(), "the file's order differs").toEqual(["B", "A-0", "A-74"]);
	});

	it("the copy renamed while the clear reads the file: its pieces are kept once, under B, and saved under the new path", async () => {
		const r = rig();
		await lockedCopyOpen();
		erase({ x: 60, y: 100 });
		const cut = names(inlineInk.strokes(C));
		expect(cut, "precondition: the cut left A's two pieces where A stood, under B").toEqual(["A-0", "A-74", "B"]);
		r.hold();
		const reads = r.reads.length;
		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		expect(r.reads.length - reads, "precondition: the clear's read is waiting").toBe(1);
		const saves = r.saves.length;
		r.rename(C, R);

		r.release();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(R), "precondition: the read lifted the renamed copy's lock").toBe(false);

		expect(names(inlineInk.strokes(R)), "the renamed copy's pieces moved above B, or one is there twice").toEqual(cut);
		expect(r.saves.length - saves, "the renamed copy's pieces were not saved once").toBe(1);
		expect(r.onDisk(), "the file does not hold each piece once, under B").toEqual(cut);
	});
});

describe("one eraser gesture cuts A, then cuts its own fresh piece", () => {
	it("pieces of a piece the same gesture cut again stand under B after the clear, in the copy and in the file", async () => {
		const r = rig();
		await lockedCopyOpen();
		const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
		view.mode = "erase";
		view.scale = 1;
		view.eraseWhole = false;
		view.erased = [];
		view.erasePieces = new Set<string>();
		view.strokeIndex = new StrokeIndex();
		view.indexDirty = true;
		view.damage = { addRect: () => undefined, addAll: () => undefined };
		view.camera = { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) };
		view.filePath = () => C;
		view.repaintPath = () => undefined;
		view.scheduleRepaint = () => undefined;
		const proto = InkOverlayPlugin.prototype as unknown as { eraseAt(this: unknown, sample: unknown): void };
		// The bare view is in no pane's index list, so its index is rebuilt from the store before each sample; the
		// gesture's own state (erasePieces, which makes the second cut `fresh`) is kept.
		for (const x of [60, 110]) {
			view.indexDirty = true;
			proto.eraseAt.call(view, { x, y: 100, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
		}
		const cut = names(inlineInk.strokes(C));
		expect(cut, "precondition: one gesture left three pieces of A under B").toEqual(["A-0", "A-74", "A-124", "B"]);
		expect((view.erased as unknown[]).length, "precondition: one history entry, A; the fresh piece is in none").toBe(1);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "a piece of a fresh piece moved above the stroke drawn across it").toEqual(cut);
		expect(r.onDisk(), "the file holds a piece of a fresh piece above the stroke drawn across it").toEqual(cut);
	});
});
