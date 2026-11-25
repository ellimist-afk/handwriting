/**
 * A note and its copy carry the same page id, and only the copy is duplicate-locked. Both are open on the shared page:
 * stroke A across the page, then stroke B drawn down across A. While the copy is locked both notes change A: the original
 * cuts it, or erases it, and saves; the copy cuts it, erases it, moves it, or changes a group A is in. The original is
 * deleted, and the delete's clear reads the shared file again and saves the copy's own changes over it.
 *
 * The copy's version of A wins. After the clear A's line is drawn once, as the copy left it: the original's pieces of A
 * are not taken, the copy's version stands where the first of those pieces stood (under B), and nothing the copy erased
 * shows. Undo and redo after the clear leave the line once. Ink the original drew or pasted along A stays, and so do its
 * pieces of a stroke the copy left alone, or of a change the copy had already saved. A change the copy handed to a save
 * that never landed, its page taken over in the queue by the original's, is still the copy's: the line once, as moved.
 *
 * Real InlineInkStore (the plugin's), real PageStore over FakeAdapter, the real delete handler on a plugin built without
 * its constructor, and the real eraser (eraseAt) on a bare overlay with the partial eraser on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import HandwritingPlugin from "../main";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";
import { PageIdIndex } from "../model/PageIdIndex";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import { StrokeIndex } from "../ink/StrokeIndex";
import { splitStrokeByCircle } from "../ink/Eraser";
import { newStrokeId, type InkStroke } from "../ink/Stroke";

const N = "Original.md";
const C = "Original 1.md";
const X = "shared-id";
const FILE = `.handwriting/${X}.json`;

/** A stroke along the corners given, a point every 2 px on each leg. */
function polyline(id: string, corners: ReadonlyArray<[number, number]>, opts: { color?: string; createdAt?: number } = {}): InkStroke {
	const points: Array<{ x: number; y: number; pressure: number; t: number }> = [];
	for (let c = 0; c + 1 < corners.length; c++) {
		const [x0, y0] = corners[c]!;
		const [x1, y1] = corners[c + 1]!;
		const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / 2;
		for (let i = c === 0 ? 0 : 1; i <= n; i++) points.push({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n, pressure: 0.5, t: points.length });
	}
	const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
	const x = Math.min(...xs), y = Math.min(...ys);
	return {
		id, tool: "pen", color: opts.color ?? "#000000", width: 2, points,
		bbox: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }, createdAt: opts.createdAt ?? 0,
	};
}

/** A: across the page at y 100. B: down the page at x 150, across A. D: far below both. */
const A = (): InkStroke => polyline("A", [[0, 100], [200, 100]]);
const B = (): InkStroke => polyline("B", [[150, 40], [150, 160]], { color: "#ff0000" });
const D = (): InkStroke => polyline("D", [[0, 400], [100, 400]], { color: "#0000ff" });

/** A stroke by its id; a piece (a generated id) by where it starts and ends, rounded: "0,100>45,100". */
function name(s: InkStroke): string {
	if (s.id.length <= 2) return s.id;
	const a = s.points[0]!, b = s.points[s.points.length - 1]!;
	return `${Math.round(a.x)},${Math.round(a.y)}>${Math.round(b.x)},${Math.round(b.y)}`;
}
const names = (list: readonly InkStroke[]): string[] => list.map(name);

/** A's pieces after a cut at x 60 (the copy's) and at x 110 (the original's): the ring takes 15 px each side (14 + half A's width). */
const C60 = ["0,100>45,100", "75,100>200,100"];
const N110 = ["0,100>95,100", "125,100>200,100"];

const DOC = "One line.\nThe word benzene here.\n";

function group(id: string, strokeIds: string[]): AttachmentRecord {
	const from = DOC.indexOf("benzene");
	return {
		v: 1, id, strokeIds, target: targetAt(DOC, from, from + 7, "range"), ref: { x: 0, y: 20 },
		layout: { width: 600, font: 16 }, probe: { id: strokeIds[0]!, x: 0, y: 100 },
	};
}
const members = (list: readonly AttachmentData[], id: string): string[] | undefined => {
	const g = list.find((a) => a.id === id) as AttachmentRecord | undefined;
	return g?.strokeIds.map((m) => (m.length <= 2 ? m : "piece"));
};

/**
 * Two notes on one id, the shared file holding `strokes` (A then B unless given) and `groups`. Saves and file reads are
 * counted as the store is asked for them. `throwNext` makes the next read of the shared file throw in the adapter, as a
 * busy disk or a sync client mid-write does, so the store answers that the file is not readable yet.
 */
function rig(opts: { strokes?: InkStroke[]; groups?: AttachmentData[] } = {}) {
	const fake = new FakeAdapter();
	let throwing = false;
	const read = fake.read.bind(fake);
	fake.read = async (path: string): Promise<string> => {
		if (throwing && path === FILE) {
			throwing = false;
			throw new Error("EBUSY: the ink file is being written");
		}
		return read(path);
	};
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const shared = emptyPage(X);
	shared.surface = "inline";
	shared.strokes = opts.strokes ?? [A(), B()];
	if (opts.groups) shared.attachments = opts.groups;
	fake.files.set(FILE, serializePage(shared));
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
		// As the plugin's host answers: whether this page's own write landed.
		sidecarLanded: (page) => store.hasLanded(page),
		notify: () => undefined,
	};
	inlineInk.attachHost(host);
	const filePage = () => {
		const t = fake.files.get(FILE);
		return t === undefined ? null : parsePage(t, X).data;
	};
	const onDisk = (): string[] => names(filePage()?.strokes ?? []);
	const groupsOnDisk = (): readonly AttachmentData[] => filePage()?.attachments ?? [];
	/** The original is deleted: the plugin's delete handler, then the inline store's, as Obsidian calls them. */
	const deleteOriginal = async (): Promise<void> => {
		listed.delete(N);
		const handled = plugin.onFileDeleted(files.get(N));
		inlineInk.handleDelete(N);
		await handled;
	};
	const throwNext = (): void => {
		throwing = true;
	};
	const drain = async (): Promise<void> => {
		for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(2000);
		await store.flush();
		for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(2000);
	};
	return { store, saves, reads, filePage, onDisk, groupsOnDisk, deleteOriginal, throwNext, drain };
}

/**
 * One eraser gesture on a note through the real eraseAt (ring 14 px at scale 1), on a bare overlay: partial unless
 * `whole`. Returns what history keeps of it: the strokes taken, with their indices. No save: the caller's pen-up does it.
 */
function erase(path: string, at: { x: number; y: number }, whole = false): Array<{ stroke: InkStroke; index: number }> {
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
	view.filePath = () => path;
	view.repaintPath = () => undefined;
	view.scheduleRepaint = () => undefined;
	const proto = InkOverlayPlugin.prototype as unknown as { eraseAt(this: unknown, sample: unknown): void };
	proto.eraseAt.call(view, { ...at, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
	return view.erased as Array<{ stroke: InkStroke; index: number }>;
}

/** A cut on the original, with its pen-up save, landed in the file. */
async function originalCuts(r: ReturnType<typeof rig>, at: { x: number; y: number }, whole = false): Promise<void> {
	erase(N, at, whole);
	inlineInk.save(N);
	await r.drain();
}

/**
 * The original's cut of A at x 110, made in its store as eraseAt makes it (the same ring, 14 px at scale 1), with its
 * pen-up save, landed in the file. On a note with attached groups the bare overlay's eraser cuts nothing.
 */
async function originalCutsAInStore(r: ReturnType<typeof rig>): Promise<void> {
	const taken = inlineInk.takeLive(N, ["A"]);
	expect(taken.length, "precondition: the original held A").toBe(1);
	const { stroke, index } = taken[0]!;
	inlineInk.reinsertLive(N, [{ index, pieces: splitStrokeByCircle(stroke, 110, 100, 14, newStrokeId), parent: "A" }]);
	inlineInk.save(N);
	await r.drain();
}

/**
 * A cut on the copy, as history keeps it: the strokes it took with their places, and the pieces it left with theirs.
 * `undo` and `redo` run its replace step as the editor's history does (whole or not at all, then the save).
 */
function copyCuts(at: { x: number; y: number }, whole = false) {
	const before = new Set(inlineInk.strokes(C).map((s) => s.id));
	const taken = erase(C, at, whole);
	const list = inlineInk.strokes(C);
	const pieces = list.filter((s) => !before.has(s.id));
	const placed = pieces.map((p) => list.indexOf(p));
	const replace = (removed: readonly InkStroke[], inserted: readonly InkStroke[], indices: readonly number[]): boolean => {
		if (!inlineInk.holdsAll(C, removed.map((s) => s.id))) return false;
		inlineInk.takeLive(C, removed.map((s) => s.id));
		inlineInk.applyAddLive(C, inserted, indices);
		inlineInk.save(C);
		return true;
	};
	return {
		undo: () => replace(pieces, taken.map((e) => e.stroke), taken.map((e) => e.index)),
		redo: () => replace(taken.map((e) => e.stroke), pieces, placed),
	};
}

/** The copy locked alone, as a failed repair leaves it; both notes open on the shared page. */
async function lockedCopyOpen(): Promise<void> {
	inlineInk.markDuplicateLocked(C, N);
	await inlineInk.ensureLoaded(C);
	await inlineInk.ensureLoaded(N);
	expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
}

/** The lock clears on the original's delete; then everything queued is flushed. */
async function clear(r: ReturnType<typeof rig>): Promise<void> {
	await r.deleteOriginal();
	await r.drain();
	expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);
}

const yOf = (id: string): number | undefined => inlineInk.strokes(C).find((s) => s.id === id)?.points[0]?.y;

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	inlineInk.handleDelete(N);
	inlineInk.handleDelete(C);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("a line both notes changed while the copy was locked is drawn once after the clear, as the copy left it", () => {
	it("both cut A at different places: the copy's pieces stand where the original's first piece stood, under B, and the original's are gone", async () => {
		const r = rig();
		await lockedCopyOpen();
		await originalCuts(r, { x: 110, y: 100 });
		expect(r.onDisk(), "precondition: the original's cut reached the file").toEqual([...N110, "B"]);
		copyCuts({ x: 60, y: 100 });
		expect(names(inlineInk.strokes(C)), "precondition: the copy's cut left its pieces under B").toEqual([...C60, "B"]);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "A's line is drawn twice, or the copy's pieces left B's underside").toEqual([...C60, "B"]);
		expect(r.onDisk(), "the file draws A's line twice, or the copy's pieces left B's underside").toEqual([...C60, "B"]);
	});

	it("the copy moved A, the original cut it: A stands moved, once, where the original's first piece stood", async () => {
		const r = rig();
		await lockedCopyOpen();
		await originalCuts(r, { x: 110, y: 100 });
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "the original's pieces stayed beside the copy's moved A, or A left B's underside").toEqual(["A", "B"]);
		expect(yOf("A"), "A is not where the copy moved it").toBe(130);
		expect(r.onDisk(), "the file draws A's line twice").toEqual(["A", "B"]);
	});

	it("the copy erased A whole, the original cut it: nothing of A shows", async () => {
		const r = rig();
		await lockedCopyOpen();
		await originalCuts(r, { x: 110, y: 100 });
		erase(C, { x: 60, y: 100 }, true);
		inlineInk.save(C);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "ink the copy erased shows again").toEqual(["B"]);
		expect(r.onDisk(), "the file holds ink the copy erased").toEqual(["B"]);
	});

	it("the copy cut A and undid the cut, the original cut it: A stands whole, once, and the copy's redo of its cut still applies", async () => {
		const r = rig();
		await lockedCopyOpen();
		await originalCuts(r, { x: 110, y: 100 });
		const cut = copyCuts({ x: 60, y: 100 });
		expect(cut.undo(), "precondition: the copy's undo ran").toBe(true);
		expect(names(inlineInk.strokes(C)), "precondition: the undo put A back").toEqual(["A", "B"]);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "A's line is drawn twice, or A is not whole").toEqual(["A", "B"]);
		expect(r.onDisk(), "the file draws A's line twice, or A is not whole").toEqual(["A", "B"]);
		expect(cut.redo(), "the copy's redo of its cut did not apply").toBe(true);
		await r.drain();
		expect(names(inlineInk.strokes(C)), "the redo did not leave the copy's pieces once, under B").toEqual([...C60, "B"]);
		expect(r.onDisk(), "the file does not hold the redo's page").toEqual([...C60, "B"]);
	});

	it("the clear's read throws and a later read heals: the copy's pieces once, none of the original's, in the copy and in the file", async () => {
		const r = rig();
		await lockedCopyOpen();
		await originalCuts(r, { x: 110, y: 100 });
		copyCuts({ x: 60, y: 100 });
		r.throwNext();
		await clear(r);
		expect(inlineInk.isDamagedLocked(C), "precondition: the clear's read threw and holds the copy").toBe(true);
		expect(r.onDisk(), "precondition: nothing was written while the read could not land").toEqual([...N110, "B"]);

		await inlineInk.ensureLoaded(C);
		await r.drain();

		expect(inlineInk.isDamagedLocked(C), "precondition: the read healed").toBe(false);
		expect(names(inlineInk.strokes(C)), "the heal drew A's line twice").toEqual([...C60, "B"]);
		expect(r.onDisk(), "the heal saved A's line twice").toEqual([...C60, "B"]);
	});

	it("undo and redo of the copy's cut after the clear leave A's line once, and the file holds each page shown", async () => {
		const r = rig();
		await lockedCopyOpen();
		await originalCuts(r, { x: 110, y: 100 });
		const cut = copyCuts({ x: 60, y: 100 });
		await clear(r);
		expect(names(inlineInk.strokes(C)), "precondition: the clear left the copy's pieces").toEqual([...C60, "B"]);

		expect(cut.undo(), "the undo did not apply").toBe(true);
		await r.drain();
		expect(names(inlineInk.strokes(C)), "the undo drew A's line twice").toEqual(["A", "B"]);
		expect(r.onDisk(), "the file does not hold the undo's page").toEqual(["A", "B"]);

		expect(cut.redo(), "the redo did not apply").toBe(true);
		await r.drain();
		expect(names(inlineInk.strokes(C)), "the redo drew A's line twice").toEqual([...C60, "B"]);
		expect(r.onDisk(), "the file does not hold the redo's page").toEqual([...C60, "B"]);
	});

	it("undo of the copy's move after the clear puts A back where it was, once", async () => {
		const r = rig();
		await lockedCopyOpen();
		await originalCuts(r, { x: 110, y: 100 });
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);
		await clear(r);
		expect(yOf("A"), "precondition: the clear kept the copy's move").toBe(130);

		expect(inlineInk.standsAt(C, ["A"], [{ x: 0, y: 130 }]), "the move's undo would not apply").toBe(true);
		inlineInk.moveStrokes(C, ["A"], 0, -30);
		inlineInk.save(C);
		await r.drain();

		expect(names(inlineInk.strokes(C)), "the undo drew A's line twice").toEqual(["A", "B"]);
		expect(yOf("A"), "A is not back where it was").toBe(100);
		expect(r.onDisk(), "the file does not hold the undo's page").toEqual(["A", "B"]);
	});

	it("a member of a group the copy changed, cut by the original: it stands whole, once, in the copy's group", async () => {
		const r = rig({ strokes: [A(), B(), D()], groups: [group("g0", ["A", "D"])] });
		await lockedCopyOpen();
		await originalCutsAInStore(r);
		expect(r.onDisk(), "precondition: the original's cut reached the file").toEqual([...N110, "B", "D"]);
		inlineInk.setAttachments(C, [group("g0", ["A"])], true);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "A is gone, or the original's pieces stayed").toEqual(["A", "B", "D"]);
		expect(r.onDisk(), "the file lost A, or holds the original's pieces").toEqual(["A", "B", "D"]);
		expect(members(r.groupsOnDisk(), "g0"), "the copy's group does not hold A").toEqual(["A"]);
	});

	it("a group the copy removed, its member cut by the original: the member stands whole, once, in no group", async () => {
		const r = rig({ strokes: [A(), B(), D()], groups: [group("g0", ["A", "D"])] });
		await lockedCopyOpen();
		await originalCutsAInStore(r);
		expect(r.onDisk(), "precondition: the original's cut reached the file").toEqual([...N110, "B", "D"]);
		inlineInk.setAttachments(C, [], true);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "A is gone, or the original's pieces stayed").toEqual(["A", "B", "D"]);
		expect(r.onDisk(), "the file lost A, or holds the original's pieces").toEqual(["A", "B", "D"]);
		expect(r.groupsOnDisk(), "a group the copy removed is back").toEqual([]);
	});
});

describe("what the original drew, pasted or cut on a line the copy left alone stays after the clear", () => {
	it("a paste equal to A on the original, which then erased A: the paste stays beside the copy's pieces", async () => {
		const r = rig();
		await lockedCopyOpen();
		inlineInk.commit(N, { ...A(), id: "P" });
		inlineInk.applyRemove(N, ["A"]);
		await r.drain();
		expect(r.onDisk(), "precondition: the original holds the paste and not A").toEqual(["B", "P"]);
		copyCuts({ x: 60, y: 100 });

		await clear(r);

		expect(names(inlineInk.strokes(C)), "the original's paste was taken for a piece of A").toEqual(["B", "P", ...C60]);
		expect(r.onDisk(), "the file lost the original's paste").toEqual(["B", "P", ...C60]);
	});

	it("pieces of a sibling that shares A's time, on a hooked line: the original's stay, the copy's cut of the other piece stands once", async () => {
		// E1 and E2: the two pieces of one hooked stroke cut earlier, with its time; E1's box holds all of E2.
		const E1 = polyline("E1", [[0, 0], [200, 0], [200, 200], [50, 200], [50, 140]], { createdAt: 5 });
		const E2 = polyline("E2", [[50, 110], [50, 50], [150, 50]], { createdAt: 5 });
		const r = rig({ strokes: [E1, E2] });
		await lockedCopyOpen();
		await originalCuts(r, { x: 200, y: 100 });
		await originalCuts(r, { x: 100, y: 50 });
		const kept = r.onDisk().filter((n) => n.startsWith("50,110") || n.startsWith("115,50"));
		expect(kept, "precondition: the original cut E2 in two").toEqual(["50,110>85,50", "115,50>150,50"]);
		copyCuts({ x: 100, y: 0 });
		const mine = names(inlineInk.strokes(C)).filter((n) => n !== "E2");

		await clear(r);

		expect(names(inlineInk.strokes(C)), "the original's pieces of E2 were taken for pieces of E1, or E1's line is twice").toEqual([...mine, ...kept]);
		expect(r.onDisk(), "the file lost the original's pieces of E2, or draws E1's line twice").toEqual([...mine, ...kept]);
	});

	it("the original cut A and the copy left A alone: the original's pieces stay, and A does not come back", async () => {
		const r = rig({ strokes: [A(), B(), D()] });
		await lockedCopyOpen();
		await originalCuts(r, { x: 110, y: 100 });
		erase(C, { x: 50, y: 400 });
		inlineInk.save(C);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "the original's cut of a stroke the copy left alone was undone").toEqual([...N110, "B", "0,400>35,400", "65,400>100,400"]);
		expect(r.onDisk(), "the file lost the original's cut").toEqual([...N110, "B", "0,400>35,400", "65,400>100,400"]);
	});

	it("ink the original drew along A, on A's own points, stays when both cut A", async () => {
		const r = rig();
		await lockedCopyOpen();
		// Y lies on A's samples from x 130 to its end, clear of the original's cut at 110.
		const along = A();
		inlineInk.commit(N, { ...along, id: "Y", points: along.points.slice(65).map((p) => ({ ...p })), createdAt: 7 });
		await originalCuts(r, { x: 110, y: 100 });
		expect(r.onDisk(), "precondition: the original's stroke along A and its cut of A are in the file").toEqual([...N110, "B", "Y"]);
		copyCuts({ x: 60, y: 100 });

		await clear(r);

		expect(names(inlineInk.strokes(C)), "the original's stroke along A was taken for a piece of A").toContain("Y");
		expect(r.onDisk(), "the file lost the original's stroke along A").toContain("Y");
	});

	it("a stroke the original added to a group the copy changed stays, loose", async () => {
		const r = rig({ strokes: [A(), B(), D()], groups: [group("g0", ["A", "D"])] });
		await lockedCopyOpen();
		inlineInk.commit(N, { ...D(), id: "Y", createdAt: 9 });
		inlineInk.setAttachments(N, [group("g0", ["A", "D", "Y"])], true);
		await r.drain();
		inlineInk.setAttachments(C, [group("g0", ["A"])], true);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "the original's stroke in the group was dropped").toEqual(["A", "B", "D", "Y"]);
		expect(r.onDisk(), "the file lost the original's stroke in the group").toEqual(["A", "B", "D", "Y"]);
		expect(members(r.groupsOnDisk(), "g0"), "the copy's group is not the one saved").toEqual(["A"]);
	});

	it("pieces the original cut from a piece the copy saved before its lock stay", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		erase(C, { x: 60, y: 100 });
		inlineInk.save(C);
		await r.drain();
		expect(r.onDisk(), "precondition: the copy's cut was saved before the lock").toEqual([...C60, "B"]);
		await inlineInk.ensureLoaded(N);
		expect(names(inlineInk.strokes(N)), "precondition: the original loaded the copy's saved cut").toEqual([...C60, "B"]);
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		await originalCuts(r, { x: 110, y: 100 });
		const theirs = ["75,100>95,100", "125,100>200,100"];
		expect(r.onDisk(), "precondition: the original cut the copy's saved piece").toEqual(["0,100>45,100", ...theirs, "B"]);

		await clear(r);

		for (const piece of theirs) {
			expect(names(inlineInk.strokes(C)).filter((n) => n === piece), `the original's piece ${piece} is not in the copy once`).toHaveLength(1);
			expect(r.onDisk().filter((n) => n === piece), `the original's piece ${piece} is not in the file once`).toHaveLength(1);
		}
		expect(names(inlineInk.strokes(C)), "the copy's saved piece the original cut again is still in the copy").not.toContain("75,100>200,100");
		expect(r.onDisk(), "the copy's saved piece the original cut again is still in the file").not.toContain("75,100>200,100");
	});
});

describe("a change the copy saved before its lock, then cut again by the original, is the file's at the clear", () => {
	it("the copy's saved piece that the original cut again is not drawn beside the original's pieces", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		erase(C, { x: 60, y: 100 });
		inlineInk.save(C);
		await r.drain();
		await inlineInk.ensureLoaded(N);
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		await originalCuts(r, { x: 110, y: 100 });
		expect(r.onDisk(), "precondition: the original cut the copy's saved piece").toEqual(["0,100>45,100", "75,100>95,100", "125,100>200,100", "B"]);

		await clear(r);

		expect(r.onDisk(), "the file holds the piece 75>200 beside the original's pieces of it").toEqual(["0,100>45,100", "75,100>95,100", "125,100>200,100", "B"]);
		expect(names(inlineInk.strokes(C)), "the copy draws the piece 75>200 beside the original's pieces of it").toEqual(["0,100>45,100", "75,100>95,100", "125,100>200,100", "B"]);
	});

	it("A moved and saved by the copy before its lock, then cut by the original, is not drawn beside the original's pieces", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);
		await r.drain();
		await inlineInk.ensureLoaded(N);
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		await originalCuts(r, { x: 110, y: 130 });
		expect(r.onDisk(), "precondition: the original cut the copy's saved A").toEqual(["0,130>95,130", "125,130>200,130", "B"]);

		await clear(r);

		expect(r.onDisk(), "the file holds A beside the original's pieces of it").toEqual(["0,130>95,130", "125,130>200,130", "B"]);
		expect(names(inlineInk.strokes(C)), "the copy draws A beside the original's pieces of it").toEqual(["0,130>95,130", "125,130>200,130", "B"]);
	});

	it("A moved and saved, then a save that changes no stroke before the write: only the later page lands, and A's move is still the file's", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);
		inlineInk.save(C);
		await r.drain();
		await inlineInk.ensureLoaded(N);
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		await originalCuts(r, { x: 110, y: 130 });
		expect(r.onDisk(), "precondition: the original cut the copy's saved A").toEqual(["0,130>95,130", "125,130>200,130", "B"]);

		await clear(r);

		expect(r.onDisk(), "the file holds A beside the original's pieces of it").toEqual(["0,130>95,130", "125,130>200,130", "B"]);
		expect(names(inlineInk.strokes(C)), "the copy draws A beside the original's pieces of it").toEqual(["0,130>95,130", "125,130>200,130", "B"]);
	});

	it("A moved and saved, then an Attach saved before the write: A's move is still the file's when the original cut it", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);
		inlineInk.setAttachments(C, [group("g1", ["B"])], true);
		await r.drain();
		expect(members(r.groupsOnDisk(), "g1"), "precondition: the Attach landed").toEqual(["B"]);
		await inlineInk.ensureLoaded(N);
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		// The original's cut of the moved A at x 110, as eraseAt makes it: a note with attached groups is cut in its store.
		const taken = inlineInk.takeLive(N, ["A"]);
		expect(taken.length, "precondition: the original held A").toBe(1);
		inlineInk.reinsertLive(N, [{ index: taken[0]!.index, pieces: splitStrokeByCircle(taken[0]!.stroke, 110, 130, 14, newStrokeId), parent: "A" }]);
		inlineInk.save(N);
		await r.drain();
		expect(r.onDisk(), "precondition: the original cut the copy's saved A").toEqual(["0,130>95,130", "125,130>200,130", "B"]);

		await clear(r);

		expect(r.onDisk(), "the file holds A beside the original's pieces of it").toEqual(["0,130>95,130", "125,130>200,130", "B"]);
		expect(names(inlineInk.strokes(C)), "the copy draws A beside the original's pieces of it").toEqual(["0,130>95,130", "125,130>200,130", "B"]);
	});

	it("control: A moved and saved, then B moved and saved before the write: A's move is the file's when the original cut it", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);
		inlineInk.moveStrokes(C, ["B"], 5, 0);
		inlineInk.save(C);
		await r.drain();
		await inlineInk.ensureLoaded(N);
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		await originalCuts(r, { x: 110, y: 130 });
		expect(r.onDisk(), "precondition: the original cut the copy's saved A").toEqual(["0,130>95,130", "125,130>200,130", "B"]);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "the copy draws A beside the original's pieces of it").toEqual(["0,130>95,130", "125,130>200,130", "B"]);
		expect(r.onDisk(), "the file holds A beside the original's pieces of it").toEqual(["0,130>95,130", "125,130>200,130", "B"]);
	});

	it("control: A moved and saved, landed; locked, the copy moves A again; the original cuts A: the copy's newer move stands, once", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);
		await r.drain();
		await inlineInk.ensureLoaded(N);
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);
		await originalCuts(r, { x: 110, y: 130 });

		await clear(r);

		expect(names(inlineInk.strokes(C)).filter((n) => n === "A"), "the copy's newer move of A is lost or doubled").toHaveLength(1);
		expect(yOf("A"), "A is not where the copy moved it last").toBe(160);
		expect(r.onDisk(), "the file holds the original's pieces beside the copy's newer A").toEqual(["A", "B"]);
	});

	it("A moved and saved, landed; locked, the copy moves A again; the original, open since before that save, cuts A where it stood for it: A's line once, as moved last", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);
		await r.drain();
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		await originalCuts(r, { x: 110, y: 100 });
		expect(r.onDisk(), "precondition: the original's cut of A as it held it replaced the file").toEqual([...N110, "B"]);

		await clear(r);

		expect({ strokes: names(inlineInk.strokes(C)), y: yOf("A") }, "A's line is drawn twice, or A is not where the copy moved it last").toEqual({ strokes: ["A", "B"], y: 160 });
		expect(r.onDisk(), "the file draws A's line twice").toEqual(["A", "B"]);
	});

	it("A moved and saved, landed; moved and saved again, that page replaced in the queue by the original's cut of A as it held it before both: A's line once, as moved last", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);
		await r.drain();
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		await originalCuts(r, { x: 110, y: 100 });
		expect(r.onDisk(), "precondition: the original's cut took the queue from the copy's second save").toEqual([...N110, "B"]);

		await clear(r);

		expect({ strokes: names(inlineInk.strokes(C)), y: yOf("A") }, "A's line is drawn twice, or A is not where the copy moved it last").toEqual({ strokes: ["A", "B"], y: 160 });
		expect(r.onDisk(), "the file draws A's line twice").toEqual(["A", "B"]);
	});

	it("the copy cut A and saved, landed; the original, open since before that save, drew and saved with A whole: A once, whole, and none of the copy's pieces", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		copyCuts({ x: 60, y: 100 });
		inlineInk.save(C);
		await r.drain();
		expect(r.onDisk(), "precondition: the copy's cut landed").toEqual([...C60, "B"]);
		inlineInk.markDuplicateLocked(C, N);
		inlineInk.commit(N, D());
		inlineInk.save(N);
		await r.drain();
		expect(r.onDisk(), "precondition: the original's page, A whole, replaced the file").toEqual(["A", "B", name(D())]);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "the copy's saved pieces stand beside A whole").toEqual(["A", "B", name(D())]);
		expect(r.onDisk(), "the file holds the copy's saved pieces beside A whole").toEqual(["A", "B", name(D())]);
	});

	it("the copy cut A and saved, landed; the original, open since before that save, cut A its own way: the original's pieces only", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		copyCuts({ x: 60, y: 100 });
		inlineInk.save(C);
		await r.drain();
		inlineInk.markDuplicateLocked(C, N);
		await originalCuts(r, { x: 110, y: 100 });
		expect(r.onDisk(), "precondition: the original's cut of A whole replaced the file").toEqual([...N110, "B"]);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "the copy's saved pieces stand beside the original's").toEqual([...N110, "B"]);
		expect(r.onDisk(), "the file holds the copy's saved pieces beside the original's").toEqual([...N110, "B"]);
	});

	it("A moved and saved by the copy, landed, not moved again; the original, open since before that save, cut A as it held it: the original's pieces only, once", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);
		await r.drain();
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		await originalCuts(r, { x: 110, y: 100 });
		expect(r.onDisk(), "precondition: the original's cut of A as it held it replaced the file").toEqual([...N110, "B"]);

		await clear(r);

		expect({ copy: names(inlineInk.strokes(C)), file: r.onDisk() }, "A drawn beside the original's pieces of it").toEqual({ copy: [...N110, "B"], file: [...N110, "B"] });
	});

	it("A moved and saved, that page replaced in the queue by the original's cut; the copy then reads the file anew, is locked and cleared: the original's pieces, none lost", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);
		await originalCuts(r, { x: 110, y: 100 });
		expect(r.onDisk(), "precondition: the original's cut took the queue").toEqual([...N110, "B"]);
		expect(await inlineInk.reloadExternal(C), "precondition: the copy read the file anew").toBe(true);
		expect(names(inlineInk.strokes(C)), "precondition: the copy holds the file's page").toEqual([...N110, "B"]);
		inlineInk.markDuplicateLocked(C, N);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "the original's pieces left the copy").toEqual([...N110, "B"]);
		expect(r.onDisk(), "the original's pieces left the file").toEqual([...N110, "B"]);
	});

	it("control: A moved by the copy while locked, not saved, cut by the original, stands once as moved", async () => {
		const r = rig();
		await lockedCopyOpen();
		await originalCuts(r, { x: 110, y: 100 });
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "the original's pieces stayed beside the copy's moved A").toEqual(["A", "B"]);
		expect(r.onDisk(), "the file draws A twice").toEqual(["A", "B"]);
	});

	it("A moved and saved by the copy, landed; the original, open since before that save, cut A as it held it and moved both pieces: the original's pieces only, once", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);
		await r.drain();
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		await originalCuts(r, { x: 110, y: 100 });
		const pieces = inlineInk.strokes(N).filter((s) => s.id !== "B").map((s) => s.id);
		expect(pieces.length, "precondition: the original's cut left two pieces").toBe(2);
		inlineInk.moveStrokes(N, pieces, 0, 50);
		inlineInk.save(N);
		await r.drain();
		const file = r.onDisk();
		expect(file, "precondition: the original's moved pieces replaced the file").toEqual(["0,150>95,150", "125,150>200,150", "B"]);

		await clear(r);

		expect({ copy: names(inlineInk.strokes(C)), file: r.onDisk() }, "A drawn beside the original's moved pieces of it").toEqual({ copy: file, file });
	});

	// A saved stroke is dropped only where the file shows the other side's act on it. These hold strokes shaped like a moved
	// piece that no cut made: the saved stroke stays.
	it("c drawn and saved by the copy, landed; the original, open since before that save, drew o, of another time, along a run of c's samples moved by one offset: c stays, once, beside o", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		inlineInk.commit(C, polyline("c", [[0, 300], [200, 300]], { createdAt: 5 }));
		await r.drain();
		expect(r.onDisk(), "precondition: the copy's stroke landed before the lock").toEqual(["A", "B", "c"]);
		inlineInk.markDuplicateLocked(C, N);
		inlineInk.commit(N, polyline("o", [[20, 350], [80, 350]], { createdAt: 9 }));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's page, which never held c, replaced the file").toEqual(["A", "B", "o"]);

		await clear(r);

		expect({ copy: names(inlineInk.strokes(C)), file: r.onDisk() }, "a stroke of another time, shaped as a moved piece of c, dropped c").toEqual({ copy: ["A", "B", "o", "c"], file: ["A", "B", "o", "c"] });
	});

	it("ink with time zero on both sides: c drawn and saved by the copy, landed; the original drew o along a run of c's samples, one point off the offset of the rest: c stays, once, beside o", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		const c = polyline("c", [[0, 300], [200, 300]]);
		const o = polyline("o", [[20, 350], [80, 350]]);
		o.points[15] = { ...o.points[15]!, y: 351 };
		expect({ c: c.createdAt, o: o.createdAt }, "precondition: both strokes carry time zero").toEqual({ c: 0, o: 0 });
		inlineInk.commit(C, c);
		await r.drain();
		expect(r.onDisk(), "precondition: the copy's stroke landed before the lock").toEqual(["A", "B", "c"]);
		inlineInk.markDuplicateLocked(C, N);
		inlineInk.commit(N, o);
		await r.drain();
		expect(r.onDisk(), "precondition: the original's page, which never held c, replaced the file").toEqual(["A", "B", "o"]);

		await clear(r);

		expect({ copy: names(inlineInk.strokes(C)), file: r.onDisk() }, "a stroke of time zero, not c's samples under one offset, dropped c").toEqual({ copy: ["A", "B", "o", "c"], file: ["A", "B", "o", "c"] });
	});

	it("c drawn and saved by the copy, landed; the original read it, pasted it 50 px lower, which keeps its time, and erased c whole: c stays, once, beside the paste", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		inlineInk.commit(C, polyline("c", [[0, 300], [200, 300]], { createdAt: 5 }));
		await r.drain();
		await inlineInk.ensureLoaded(N);
		expect(names(inlineInk.strokes(N)), "precondition: the original read the copy's stroke").toEqual(["A", "B", "c"]);
		inlineInk.markDuplicateLocked(C, N);
		inlineInk.commit(N, polyline("o", [[0, 350], [200, 350]], { createdAt: 5 }));
		inlineInk.takeLive(N, ["c"]);
		inlineInk.save(N);
		await r.drain();
		expect(r.onDisk(), "precondition: the original's page, the paste without c, replaced the file").toEqual(["A", "B", "o"]);

		await clear(r);

		expect({ copy: names(inlineInk.strokes(C)), file: r.onDisk() }, "a paste of c, all of it moved, was taken for a piece of c and dropped c").toEqual({ copy: ["A", "B", "o", "c"], file: ["A", "B", "o", "c"] });
	});

	it("ink with time zero on both sides: c drawn and saved by the copy, landed; the original drew o along a run of c's samples moved by one offset, its two ends hooked off that run: c stays, once, beside o", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		inlineInk.commit(C, polyline("c", [[0, 300], [200, 300]]));
		await r.drain();
		expect(r.onDisk(), "precondition: the copy's stroke landed before the lock").toEqual(["A", "B", "c"]);
		inlineInk.markDuplicateLocked(C, N);
		const o = polyline("o", [[20, 350], [80, 350]]);
		const last = o.points.length - 1;
		o.points[0] = { ...o.points[0]!, x: 18, y: 358 };
		o.points[last] = { ...o.points[last]!, x: 82, y: 342 };
		o.bbox = { x: 18, y: 342, width: 64, height: 16 };
		inlineInk.commit(N, o);
		await r.drain();
		expect(r.onDisk(), "precondition: the original's page, which never held c, replaced the file").toEqual(["A", "B", "o"]);

		await clear(r);

		expect({ copy: names(inlineInk.strokes(C)), file: r.onDisk() }, "a stroke whose ends leave c's run, its inner points c's samples under one offset, dropped c").toEqual({ copy: ["A", "B", "o", "c"], file: ["A", "B", "o", "c"] });
	});

	// E, straight and evenly drawn as c is, with c's time: the original's pieces of E are c's samples under one offset too.
	it.each([
		["the copy left E alone", false],
		["the copy moved E 30 px down and saved that with c", true],
	])("ink with time zero on both sides: c drawn and saved by the copy, landed, %s; the original, open since before that save, cut E as it held it: c stays, once, beside the original's pieces of E", async (_how, moved) => {
		const E = polyline("E", [[0, 200], [200, 200]]);
		const r = rig({ strokes: [A(), B(), E] });
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		if (moved) inlineInk.moveStrokes(C, ["E"], 0, 30);
		inlineInk.commit(C, polyline("c", [[0, 300], [200, 300]]));
		inlineInk.save(C);
		await r.drain();
		expect(r.onDisk(), "precondition: the copy's save landed before the lock").toEqual(["A", "B", "E", "c"]);
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		await originalCuts(r, { x: 110, y: 200 });
		const theirs = ["0,200>95,200", "125,200>200,200"];
		expect(r.onDisk(), "precondition: the original's page, its cut of E as it held it and no c, replaced the file").toEqual(["A", "B", ...theirs]);

		await clear(r);

		expect({ copy: names(inlineInk.strokes(C)), file: r.onDisk() }, "the original's pieces of E, shaped as moved pieces of c, dropped c").toEqual({ copy: ["A", "B", ...theirs, "c"], file: ["A", "B", ...theirs, "c"] });
	});
});

/**
 * The copy moved A, saved, and the save landed; the original, open since before that save, cut A as it held it and then
 * changed both pieces another way than a move, or cut A down to one piece with no sample of A inside it and moved that
 * piece. Not in this fix: a cell that fails says the line is drawn twice, A beside the original's pieces, and stays marked
 * so (it.fails) until a cut's lineage reaches the file.
 */
describe("a change the copy saved before its lock, then cut by the original, whose pieces it then changed", () => {
	async function originalCutsThen(r: ReturnType<typeof rig>, change: (pieces: InkStroke[]) => void): Promise<string[]> {
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);
		await r.drain();
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		await originalCuts(r, { x: 110, y: 100 });
		const pieces = inlineInk.strokes(N).filter((s) => s.id !== "B");
		expect(pieces.length, "precondition: the original's cut left two pieces").toBe(2);
		change(pieces);
		inlineInk.save(N);
		await r.drain();
		const file = r.onDisk();
		expect(file.length, "precondition: the original's changed pieces replaced the file").toBe(3);
		return file;
	}

	const shapeOf = (s: InkStroke, map: (p: { x: number; y: number }) => { x: number; y: number }, width = s.width) => {
		const points = s.points.map((p) => ({ ...p, ...map(p) }));
		const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
		const x = Math.min(...xs), y = Math.min(...ys);
		return { points, width, bbox: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y } };
	};

	// Fails at this fix: the pieces' points are not A's samples under one offset.
	it.fails("both pieces resized by the lasso to one and a half times: the original's pieces only, once", async () => {
		const r = rig();
		const file = await originalCutsThen(r, (pieces) => {
			inlineInk.rewriteStrokes(N, pieces.map((s) => ({ id: s.id, shape: shapeOf(s, (p) => ({ x: p.x * 1.5, y: 100 + (p.y - 100) * 1.5 }), s.width * 1.5) })));
		});

		await clear(r);

		expect({ copy: names(inlineInk.strokes(C)), file: r.onDisk() }, "A drawn beside the original's resized pieces of it").toEqual({ copy: file, file });
	});

	// Fails at this fix: the pieces' points are not A's samples under one offset.
	it.fails("both pieces turned by the lasso a quarter turn about the middle of A: the original's pieces only, once", async () => {
		const r = rig();
		const file = await originalCutsThen(r, (pieces) => {
			inlineInk.rewriteStrokes(N, pieces.map((s) => ({ id: s.id, shape: shapeOf(s, (p) => ({ x: 200 - p.y, y: p.x })) })));
		});

		await clear(r);

		expect({ copy: names(inlineInk.strokes(C)), file: r.onDisk() }, "A drawn beside the original's turned pieces of it").toEqual({ copy: file, file });
	});

	// Fails at this fix: a piece keeps its source's colour. No inline step recolours a stroke in place (moveStrokes and
	// rewriteStrokes are the only in-place changes); a restyle from another build reaches the file so: same ids, new colour.
	it.fails("both pieces restyled to another colour: the original's pieces only, once", async () => {
		const r = rig();
		const file = await originalCutsThen(r, (pieces) => {
			const taken = inlineInk.takeLive(N, pieces.map((s) => s.id));
			inlineInk.applyAddLive(N, taken.map((t) => ({ ...t.stroke, color: "#00aa00" })), taken.map((t) => t.index));
		});

		await clear(r);

		expect({ copy: names(inlineInk.strokes(C)), file: r.onDisk() }, "A drawn beside the original's restyled pieces of it").toEqual({ copy: file, file });
	});

	// Fails at this fix: a piece with no sample of A inside it is not taken for a moved piece, since no sample fixes its offset.
	it.fails("A cut down to one piece between two of its samples, which the original then moved 50 px down: the original's piece only, once", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);
		await r.drain();
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		// The original's eraser along A, cut in its store as eraseAt cuts it (ring 14 px, 15 with A's half width), each ring
		// overlapping the next, leaving only the span between A's samples at x 100 and 102: one piece, its two ring ends.
		const taken = inlineInk.takeLive(N, ["A"]);
		expect(taken.length, "precondition: the original held A").toBe(1);
		const { stroke, index } = taken[0]!;
		let pieces = [stroke];
		for (const x of [10.5, 35.5, 60.5, 85.5, 116.5, 141.5, 166.5, 191.5]) pieces = pieces.flatMap((s) => splitStrokeByCircle(s, x, 100, 14, newStrokeId));
		expect(pieces.map((s) => s.points.length), "precondition: one piece is left, with no sample of A inside it").toEqual([2]);
		inlineInk.reinsertLive(N, [{ index, pieces, parent: "A" }]);
		inlineInk.save(N);
		await r.drain();
		inlineInk.moveStrokes(N, [pieces[0]!.id], 0, 50);
		inlineInk.save(N);
		await r.drain();
		const file = r.onDisk();
		expect(file.length, "precondition: the original's moved piece and B replaced the file").toBe(2);
		expect(r.filePage()?.strokes[0]?.points.map((p) => p.y), "precondition: the piece the file holds is 50 px down").toEqual([150, 150]);

		await clear(r);

		expect({ copy: names(inlineInk.strokes(C)), file: r.onDisk() }, "A drawn beside the original's moved piece of it").toEqual({ copy: file, file });
	});
});

/**
 * The copy, locked, changed A and did not save; the original cut A and then pasted one of its pieces 50 px lower, or
 * moved its pieces. A carries a time, which a piece and a paste of it keep. A paste of a piece is A's samples under one
 * offset, as a moved piece is: in the file the two differ by nothing but an id neither note knew. The paste is ink
 * nobody erased and stays; the moved pieces, in this fix, stay too, beside the copy's A (it.fails: the line is drawn
 * twice until a cut's lineage reaches the file).
 */
describe("a change the copy made under its lock to a stroke the original cut, then pasted a piece of or moved", () => {
	const A5 = (): InkStroke => polyline("A", [[0, 100], [200, 100]], { createdAt: 5 });

	/** The original pastes its piece `at` 50 px lower: a new id, the same time, tool, colour and width. */
	async function originalPastesPiece(r: ReturnType<typeof rig>, at: string): Promise<void> {
		const piece = inlineInk.strokes(N).find((s) => name(s) === at);
		expect(piece, "precondition: the original holds that piece").toBeDefined();
		const points = piece!.points.map((p) => ({ ...p, y: p.y + 50 }));
		inlineInk.commit(N, { ...piece!, id: "S", points, bbox: { ...piece!.bbox, y: piece!.bbox.y + 50 } });
		await r.drain();
	}

	it("the copy moved A; the original cut A and pasted its left piece 50 px lower: the paste stays, beside the copy's A", async () => {
		const r = rig({ strokes: [A5(), B()] });
		await lockedCopyOpen();
		await originalCuts(r, { x: 110, y: 100 });
		await originalPastesPiece(r, "0,100>95,100");
		expect(r.onDisk(), "precondition: the original's cut and paste reached the file").toEqual([...N110, "B", "S"]);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);

		await clear(r);

		expect({ copy: names(inlineInk.strokes(C)), file: r.onDisk(), y: yOf("A") }, "the original's paste of a piece was taken for a moved piece of A and lost").toEqual({ copy: ["A", "B", "S"], file: ["A", "B", "S"], y: 130 });
	});

	it("the copy cut A; the original cut A and pasted its left piece 50 px lower: the paste stays, beside the copy's pieces", async () => {
		const r = rig({ strokes: [A5(), B()] });
		await lockedCopyOpen();
		await originalCuts(r, { x: 110, y: 100 });
		await originalPastesPiece(r, "0,100>95,100");
		expect(r.onDisk(), "precondition: the original's cut and paste reached the file").toEqual([...N110, "B", "S"]);
		copyCuts({ x: 60, y: 100 });
		inlineInk.save(C);

		await clear(r);

		expect({ copy: names(inlineInk.strokes(C)), file: r.onDisk() }, "the original's paste of a piece was taken for a moved piece of A and lost").toEqual({ copy: [...C60, "B", "S"], file: [...C60, "B", "S"] });
	});

	// The file here holds what it holds after the original cut A and moved its left piece 50 px down, but for one id.
	it("the copy moved A; the original cut A, pasted its left piece 50 px lower and erased that piece whole: the paste stays, beside the copy's A", async () => {
		const r = rig({ strokes: [A5(), B()] });
		await lockedCopyOpen();
		await originalCuts(r, { x: 110, y: 100 });
		await originalPastesPiece(r, "0,100>95,100");
		await originalCuts(r, { x: 50, y: 100 }, true);
		expect(r.onDisk(), "precondition: the original's right piece, B and the paste are the file").toEqual(["125,100>200,100", "B", "S"]);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);

		await clear(r);

		expect({ copy: names(inlineInk.strokes(C)), file: r.onDisk(), y: yOf("A") }, "the original's paste of a piece was taken for a moved piece of A and lost").toEqual({ copy: ["A", "B", "S"], file: ["A", "B", "S"], y: 130 });
	});

	/** The copy moved A 30 px down under its lock, unsaved; the original cut A and moved both pieces 50 px down; the clear. */
	async function copyMovedOriginalMovedBothPieces(): Promise<{ copy: string[]; file: string[]; y: number | undefined }> {
		const r = rig({ strokes: [A5(), B()] });
		await lockedCopyOpen();
		await originalCuts(r, { x: 110, y: 100 });
		const pieces = inlineInk.strokes(N).filter((s) => s.id !== "B").map((s) => s.id);
		expect(pieces.length, "precondition: the original's cut left two pieces").toBe(2);
		inlineInk.moveStrokes(N, pieces, 0, 50);
		inlineInk.save(N);
		await r.drain();
		expect(r.onDisk(), "precondition: the original's moved pieces replaced the file").toEqual(["0,150>95,150", "125,150>200,150", "B"]);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);

		await clear(r);

		return { copy: names(inlineInk.strokes(C)), file: r.onDisk(), y: yOf("A") };
	}

	// Its setup holds, and the copy's A stays where the copy moved it, in the copy and the file: the cell below can fail
	// for nothing but A drawn beside the original's moved pieces.
	it("the copy moved A; the original cut A and moved both pieces 50 px down: the copy's A stays where the copy moved it, in the copy and the file", async () => {
		const after = await copyMovedOriginalMovedBothPieces();

		expect(after, "the copy's A lost or not where the copy moved it").toEqual({ copy: expect.arrayContaining(["A", "B"]), file: expect.arrayContaining(["A", "B"]), y: 130 });
	});

	// Fails at this fix: on this road a stroke of the file shaped as a moved piece of A is not taken for A's, as a paste of
	// a piece is shaped so too; the original's moved pieces stay beside the copy's A.
	it.fails("the copy moved A; the original cut A and moved both pieces 50 px down: A once, where the copy moved it", async () => {
		expect(await copyMovedOriginalMovedBothPieces(), "A drawn beside the original's moved pieces of it").toEqual({ copy: ["A", "B"], file: ["A", "B"], y: 130 });
	});
});

describe("a removal the copy saved before its lock and then undid is the copy's at the clear when the original cut the stroke", () => {
	it("the copy cut A and saved, landed; locked, it undid the cut; the original, open since before that save, cut A its own way: A once, whole, in the copy and the file", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		const cut = copyCuts({ x: 60, y: 100 });
		inlineInk.save(C);
		await r.drain();
		expect(r.onDisk(), "precondition: the copy's cut landed").toEqual([...C60, "B"]);
		inlineInk.markDuplicateLocked(C, N);
		expect(cut.undo(), "precondition: the copy's undo ran").toBe(true);
		expect(names(inlineInk.strokes(C)), "precondition: the undo put A back").toEqual(["A", "B"]);
		await originalCuts(r, { x: 110, y: 100 });
		expect(r.onDisk(), "precondition: the original's cut of A whole replaced the file").toEqual([...N110, "B"]);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "A's line is drawn twice, or A is not whole").toEqual(["A", "B"]);
		expect(r.onDisk(), "the file draws A's line twice, or A is not whole").toEqual(["A", "B"]);
	});

	it("the copy erased A whole and saved, landed; locked, it undid the erase; the original, open since before that save, cut A its own way: A once, whole, in the copy and the file", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		const erased = copyCuts({ x: 60, y: 100 }, true);
		inlineInk.save(C);
		await r.drain();
		expect(r.onDisk(), "precondition: the copy's whole erase landed").toEqual(["B"]);
		inlineInk.markDuplicateLocked(C, N);
		expect(erased.undo(), "precondition: the copy's undo ran").toBe(true);
		expect(names(inlineInk.strokes(C)), "precondition: the undo put A back").toEqual(["A", "B"]);
		await originalCuts(r, { x: 110, y: 100 });
		expect(r.onDisk(), "precondition: the original's cut of A whole replaced the file").toEqual([...N110, "B"]);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "A's line is drawn twice, or A is not whole").toEqual(["A", "B"]);
		expect(r.onDisk(), "the file draws A's line twice, or A is not whole").toEqual(["A", "B"]);
	});
});

/**
 * Every page written toward the shared file (its scratch file included), parsed, in order; while `fail(true)` each such
 * write throws instead, as a full disk does, and is not kept.
 */
function writesToTheFile() {
	const write = FakeAdapter.prototype.write;
	const written: string[] = [];
	let failing = false;
	vi.spyOn(FakeAdapter.prototype, "write").mockImplementation(async function (this: FakeAdapter, path: string, data: string) {
		if (failing && path.startsWith(FILE)) throw new Error("ENOSPC: no space left on the disk");
		await write.call(this, path, data);
		if (path.startsWith(FILE)) written.push(data);
	});
	return {
		pages: () => written.map((t) => parsePage(t, X).data),
		fail: (on: boolean): void => {
			failing = on;
		},
	};
}

/** The two queue orders in which the original's save takes the place of the copy's last save before that one lands. */
const orders = [
	{ order: "inside the copy's 700 ms wait", failFirst: false },
	{ order: "after the copy's write failed, before its retry", failFirst: true },
];

describe.each(orders)("a line the copy moved and saved, the original's save taking the queue $order", ({ failFirst }) => {
	it("the original cut A where it stood for it: A stands moved, once, in the copy and the file", async () => {
		const w = writesToTheFile();
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		if (failFirst) w.fail(true);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);
		if (failFirst) {
			await vi.advanceTimersByTimeAsync(8000);
			expect(r.onDisk(), "precondition: the copy's write failed").toEqual(["A", "B"]);
		}
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		erase(N, { x: 110, y: 100 });
		inlineInk.save(N);
		w.fail(false);
		await r.drain();
		expect(r.onDisk(), "precondition: the original's cut took the queue").toEqual([...N110, "B"]);
		const pages = w.pages();
		expect(pages.length, "precondition: the original's page was written").toBeGreaterThan(0);
		expect(pages.filter((p) => p.strokes.some((s) => s.id === "A")), "precondition: a page with the copy's move reached the file").toEqual([]);

		await clear(r);

		expect({ strokes: names(inlineInk.strokes(C)), y: yOf("A") }, "A's line is drawn twice, or A is not where the copy moved it").toEqual({ strokes: ["A", "B"], y: 130 });
		const fileA = r.filePage()?.strokes.find((s) => s.id === "A")?.points[0]?.y;
		expect({ strokes: r.onDisk(), y: fileA }, "the file draws A's line twice, or A is not where the copy moved it").toEqual({ strokes: ["A", "B"], y: 130 });
	});

	// The clear keeps A as the copy's, over the original's pieces of it, and the group both notes hold names those pieces in
	// the file. After the clear the group names A alone: no id the page does not hold.
	it("A in a group both notes hold, the original cut A where it stood for it: that group holds A alone, in the copy and the file", async () => {
		const w = writesToTheFile();
		const r = rig({ groups: [group("g0", ["A"])] });
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		// As an open note's resolve does: the file's list becomes the session's.
		for (const p of [C, N]) inlineInk.setAttachments(p, inlineInk.attachments(p), false);
		if (failFirst) w.fail(true);
		inlineInk.moveStrokes(C, ["A"], 0, 30);
		inlineInk.save(C);
		if (failFirst) {
			await vi.advanceTimersByTimeAsync(8000);
			expect(r.onDisk(), "precondition: the copy's write failed").toEqual(["A", "B"]);
		}
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		// The original's cut as eraseAt makes it in its store: the bare overlay's eraser cuts nothing on a note with groups.
		const taken = inlineInk.takeLive(N, ["A"]);
		expect(taken.length, "precondition: the original held A").toBe(1);
		inlineInk.reinsertLive(N, [{ index: taken[0]!.index, pieces: splitStrokeByCircle(taken[0]!.stroke, 110, 100, 14, newStrokeId), parent: "A" }]);
		inlineInk.save(N);
		w.fail(false);
		await r.drain();
		expect({ strokes: r.onDisk(), members: members(r.groupsOnDisk(), "g0") }, "precondition: the original's cut, its pieces in the group, took the queue").toEqual({ strokes: [...N110, "B"], members: ["piece", "piece"] });

		await clear(r);

		expect({ strokes: names(inlineInk.strokes(C)), members: members(inlineInk.attachments(C), "g0") }, "A is not in the group alone, or the group names a stroke the page does not hold").toEqual({ strokes: ["A", "B"], members: ["A"] });
		expect({ strokes: r.onDisk(), members: members(r.groupsOnDisk(), "g0") }, "the file's group does not hold A alone").toEqual({ strokes: ["A", "B"], members: ["A"] });
	});
});

describe.each(orders)("a cut the copy saved, landed, then undid and saved, the original's save taking the queue $order", ({ failFirst }) => {
	it("the original, open since before the cut's save, cut A its own way: A once, whole, in the copy and the file", async () => {
		const w = writesToTheFile();
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		const cut = copyCuts({ x: 60, y: 100 });
		inlineInk.save(C);
		await r.drain();
		expect(r.onDisk(), "precondition: the copy's cut landed").toEqual([...C60, "B"]);
		if (failFirst) w.fail(true);
		expect(cut.undo(), "precondition: the copy's undo ran and saved").toBe(true);
		if (failFirst) {
			await vi.advanceTimersByTimeAsync(8000);
			expect(r.onDisk(), "precondition: the copy's write failed").toEqual([...C60, "B"]);
		}
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		erase(N, { x: 110, y: 100 });
		inlineInk.save(N);
		w.fail(false);
		await r.drain();
		expect(r.onDisk(), "precondition: the original's cut took the queue").toEqual([...N110, "B"]);
		expect(w.pages().filter((p) => p.strokes.some((s) => s.id === "A")), "precondition: a page with the copy's undo reached the file").toEqual([]);

		await clear(r);

		expect(names(inlineInk.strokes(C)), "A's line is drawn twice, or A is not whole").toEqual(["A", "B"]);
		expect(r.onDisk(), "the file draws A's line twice, or A is not whole").toEqual(["A", "B"]);
	});
});
