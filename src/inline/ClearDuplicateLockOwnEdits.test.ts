/**
 * A note and its copy carry the same page id, and only the copy is duplicate-locked. Both are open on the shared page, which
 * holds attached groups. While the copy is locked the original edits a group and saves; the copy only types, or acts on a
 * group itself. Then the copy's lock clears and it reads the shared file again.
 *
 * At the clear a group is the copy's only when a user action on the copy acted on that group and was not yet handed to a
 * save: Attach, Detach, a re-attach, a member cut, the group's ink moved. Text typed on the copy maps a group's target and
 * moves the correction it is shown at; neither makes the group the copy's, and the file's record of it stands, whole. A
 * group the copy saved is the file's again at a later clear.
 *
 * A read that fails at the clear leaves that merge owed: when the file is next read, by a reopen or by the sync poll, the
 * groups are merged as the clear would have merged them, and nothing is written unless the copy changed ink itself. A file
 * gone by then keeps every group the copy holds.
 *
 * An Attach or a Detach the copy made while locked, through the app's own step, is in the file after the clear, with its
 * members whole, once, in the group; a clear whose read throws with one waiting says at once the file could not be read.
 *
 * A stroke the copy saved is the file's again at a later clear: one the original erased since stays gone. A stroke whose
 * save has not landed (queued, failed, or replaced in the queue by the original's) stays the copy's, once. One whose save
 * landed before the lock stays too when the original, open since before that save, saves a page without it.
 *
 * An Attach or a Detach the copy saved, whose page the original's save took the place of in the queue before it landed,
 * is the copy's at the clear, with its strokes as the copy left them.
 *
 * Real InlineInkStore (the plugin's), real PageStore over FakeAdapter, the real delete handler on a plugin built without
 * its constructor; typing and Attach, Detach and a re-attach on a bare overlay over a CodeMirror Text, as an editor pane
 * runs them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { ChangeSet, Text } from "@codemirror/state";
import { BlockType, type ViewUpdate } from "@codemirror/view";
import HandwritingPlugin from "../main";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { SelectionModel } from "../objects/SelectionModel";
import { attachGroup, attachmentMembership, detachGroup, invertAttachStep, targetAt, type AttachmentData, type AttachmentRecord, type AttachStep } from "./InkAttachments";
import type { InlineInkHost } from "./InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import { splitStrokeByCircle } from "../ink/Eraser";
import { newStrokeId, type InkStroke } from "../ink/Stroke";

const N = "Original.md";
const C = "Original 1.md";
const X = "shared-id";
const FILE = `.handwriting/${X}.json`;
/** Line height of the bare pane's height map, px. */
const LH = 30;

const DOC = "One line.\nThe word benzene here.\nAnd toluene below, benzene again.\n";

/** Top of the line holding `pos` in `text`, in the bare pane's height map. */
function topAt(text: string, pos: number): number {
	return (text.slice(0, pos).split("\n").length - 1) * LH;
}

function stroke(id: string, x = 10, y = 40): InkStroke {
	return {
		id,
		color: "#000",
		width: 2,
		tool: "pen",
		points: [
			{ x, y, pressure: 0.5, t: 0 },
			{ x: x + 10, y: y + 10, pressure: 0.5, t: 8 },
		],
		bbox: { x: x - 2, y: y - 2, width: 16, height: 16 },
		createdAt: 1,
	} as InkStroke;
}

/** A stroke long enough to cut in two: across the page at y 100. */
function line(id: string): InkStroke {
	const points = Array.from({ length: 101 }, (_, i) => ({ x: i * 2, y: 100, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#000", width: 2, points, bbox: { x: 0, y: 99, width: 200, height: 2 }, createdAt: 1 };
}

const ids = (list: readonly { id: string }[]): string[] => list.map((s) => s.id);

/** Group `id` of `members` attached to the `nth` (0-based) `word` in DOC, its reference point on that word's line. */
function group(id: string, members: string[], word = "benzene", nth = 0, shown?: { dx: number; dy: number }): AttachmentRecord {
	let from = -1;
	for (let i = 0; i <= nth; i++) from = DOC.indexOf(word, from + 1);
	const top = topAt(DOC, from);
	return {
		v: 1, id, strokeIds: members, target: targetAt(DOC, from, from + word.length, "range"), ref: { x: 0, y: top },
		layout: { width: 600, font: 16 }, probe: { id: members[0]!, x: 10, y: top + 10 }, ...(shown ? { shown } : {}),
	};
}

/** `rec` moved by the user: shown at a new correction. */
const moved = (rec: AttachmentData, dy: number): AttachmentRecord => ({ ...(rec as AttachmentRecord), shown: { dx: 0, dy } });

/**
 * Two notes on one id, the shared file holding `strokes` and `groups`. Saves and reads are counted as the store is asked
 * for them. `throwNext` makes the next read of the shared file throw in the adapter, as a busy disk or a sync client
 * mid-write does, so the store answers that the file is not readable yet.
 */
function rig(opts: { strokes?: InkStroke[]; groups?: AttachmentRecord[] } = {}) {
	const fake = new FakeAdapter();
	let throwing = 0;
	let failing = false;
	const read = fake.read.bind(fake);
	fake.read = async (path: string): Promise<string> => {
		if (throwing > 0 && path === FILE) {
			throwing--;
			throw new Error("EBUSY: the ink file is being written");
		}
		return read(path);
	};
	const write = fake.write.bind(fake);
	fake.write = async (path: string, data: string): Promise<void> => {
		if (failing && path.startsWith(FILE)) throw new Error("ENOSPC: no space left on the disk");
		return write(path, data);
	};
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const shared = emptyPage(X);
	shared.surface = "inline";
	shared.strokes = opts.strokes ?? [stroke("p0", 5)];
	if (opts.groups) shared.attachments = opts.groups;
	fake.files.set(FILE, serializePage(shared));
	const files = new Map<string, TFile>();
	for (const path of [N, C]) files.set(path, Object.assign(new TFile(), { path, extension: "md", basename: path.slice(0, -3) }));
	const listed = new Set([N, C]);
	const cache = (path: string) => (files.has(path) ? { frontmatter: { "handwriting-page-id": X }, sections: [{ type: "yaml" }] } : null);
	const notices: string[] = [];
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
		loadSidecar: async (pageId) => store.load(pageId),
		scheduleSidecar: (pageId, page) => {
			saves.push(pageId);
			store.schedule(pageId, page);
		},
		scheduleSidecarNow: (pageId, page) => {
			saves.push(pageId);
			return store.saveNow(pageId, page);
		},
		notify: (m) => void notices.push(m),
		hasQueuedWrite: (pageId) => store.hasQueuedWrite(pageId),
		// As the plugin's host answers: whether this page's own write landed.
		sidecarLanded: (page) => store.hasLanded(page),
		// The sync poll's adoption: a damaged record never reaches these, it is read again through the heal.
		prepareExternalAdoption: async () => ({ kind: "unavailable" }) as never,
		acceptExternalAdoption: () => undefined,
	} as InlineInkHost;
	inlineInk.attachHost(host);
	const page = () => {
		const t = fake.files.get(FILE);
		return t === undefined ? null : parsePage(t, X).data;
	};
	const onDisk = (): string[] | null => {
		const p = page();
		return p === null ? null : ids(p.strokes);
	};
	const groupsOnDisk = (): readonly AttachmentData[] => page()?.attachments ?? [];
	const throwNext = (times = 1): void => {
		throwing = times;
	};
	/** Every write of the shared file fails (a full disk) while `on`. */
	const failWrites = (on: boolean): void => {
		failing = on;
	};
	/** The original is deleted: the plugin's delete handler, then the inline store's, as Obsidian calls them. */
	const deleteOriginal = async (): Promise<void> => {
		listed.delete(N);
		const handled = plugin.onFileDeleted(files.get(N));
		inlineInk.handleDelete(N);
		await handled;
	};
	const drain = async (): Promise<void> => {
		for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(2000);
		await store.flush();
		for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(2000);
	};
	return { store, fake, notices, saves, onDisk, groupsOnDisk, throwNext, failWrites, deleteOriginal, drain };
}

/** The copy locked alone, as a failed repair leaves it; both notes open on the shared page, their lists resolved. */
async function lockedCopyOpen(): Promise<void> {
	inlineInk.markDuplicateLocked(C, N);
	await inlineInk.ensureLoaded(C);
	await inlineInk.ensureLoaded(N);
	// As an open note's resolve does: the file's list becomes the session's.
	for (const p of [C, N]) inlineInk.setAttachments(p, inlineInk.attachments(p), false);
	expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
	expect(inlineInk.isDuplicateLocked(N), "precondition: the original is writable").toBe(false);
}

/**
 * A bare editor pane on `path` over DOC: its follow holds the store's list, and `followed` groups are read in this layout
 * (their correction moves when their line moves). `type` runs one editor change through the pane's update.
 */
function pane(path: string, followed: readonly string[] = []) {
	const state = { doc: Text.of(DOC.split("\n")) };
	const view = {
		scaleY: 1, state,
		lineBlockAt: (pos: number) => ({ top: (state.doc.lineAt(pos).number - 1) * LH, bottom: state.doc.lineAt(pos).number * LH }),
	};
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		view, filePath: () => path, fontZoom: 1, lineAnchorState: new LineAnchors(() => null),
		lineAnchorsMoved() {}, followMoved() {}, retakeLineAnchors() {}, requestFollowMeasure() {}, dispatchInk() {},
	});
	const follow = overlay.lineAnchors.follow;
	follow.setList(inlineInk.attachments(path));
	for (const id of followed) {
		const rec = inlineInk.attachments(path).find((a) => a.id === id) as AttachmentRecord;
		follow.attached(rec, topAt(DOC, rec.target.from));
	}
	const type = (changes: ChangeSet): void => {
		const startState = { doc: state.doc };
		state.doc = changes.apply(state.doc);
		overlay.followDocChanged(path, { changes, startState, state: { doc: state.doc } } as unknown as ViewUpdate);
	};
	return { overlay, follow, state, type };
}

/**
 * An editor pane on `path` over DOC that runs the lasso's Attach as the app does: the selection's box, the measure's read
 * and write in one frame, then the step just after. Each character is 8 px wide, its letters 16 px high in a 30 px line.
 */
function attachPane(path: string) {
	const state = { doc: Text.of(DOC.split("\n")) };
	const block = (n: number) => {
		const l = state.doc.line(n);
		return { from: l.from, to: l.to, top: (n - 1) * LH, bottom: n * LH, height: LH, type: BlockType.Text };
	};
	const view = {
		scaleY: 1, defaultLineHeight: LH, state,
		get viewport() {
			return { from: 0, to: state.doc.length };
		},
		lineBlockAt: (pos: number) => block(state.doc.lineAt(pos).number),
		lineBlockAtHeight: (h: number) => block(Math.min(state.doc.lines, Math.max(1, Math.floor(h / LH) + 1))),
		coordsAtPos: (pos: number) => {
			const l = state.doc.lineAt(pos), x = (pos - l.from) * 8, top = (l.number - 1) * LH + 7;
			return { left: x, right: x, top, bottom: top + 16 };
		},
		requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
	};
	const layout = (): LineLayout => ({ lines: state.doc.lines, lineText: (n) => state.doc.line(n).text, lineTop: (n) => (n - 1) * LH, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature({ width: 600, fontPx: 16, charWidth: 8 });
	anchors.drawn(1, state.doc.lines);
	anchors.drawn(1, state.doc.lines, true, true);
	anchors.tracks(path, inlineInk.strokes(path));
	const selection = new SelectionModel();
	let box: { x: number; y: number; width: number; height: number } | null = null;
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		view, filePath: () => path, fontZoom: 1, lineAnchorState: anchors, selection, selectionBounds: () => box,
		// The pane's place on screen, one css px a world unit: the Attach reads its words and its reference point through it.
		container: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 900, width: 900, height: 900 }) },
		inkInputPanX: () => 0, inkInputPanY: () => 0, cssScale: 1, scale: 1, pinchScaleNow: 1, pinchRefScale: null, pinchPreview: false,
		camera: { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) },
		lineAnchorsMoved() {}, followMoved() {}, retakeLineAnchors() {}, requestFollowMeasure() {}, dispatchInk() {}, redrawSelectionUI() {},
	});
	anchors.follow.setList(inlineInk.attachments(path));
	/** The lasso's Attach on the strokes `chosen`, its box around them, run to its step. */
	const attach = async (chosen: string[]): Promise<boolean> => {
		selection.selectExactly(chosen);
		const held = inlineInk.strokes(path).filter((s) => chosen.includes(s.id)).map((s) => s.bbox);
		const x = Math.min(...held.map((b) => b.x)), y = Math.min(...held.map((b) => b.y));
		box = { x, y, width: Math.max(...held.map((b) => b.x + b.width)) - x, height: Math.max(...held.map((b) => b.y + b.height)) - y };
		if (!overlay.attachSelected()) return false;
		await vi.advanceTimersByTimeAsync(0);
		return true;
	};
	return { overlay, attach };
}

/** One line typed at the top of the pane's text: every group below moves down a line. */
const typeLineAtTop = (p: ReturnType<typeof pane>): void => p.type(ChangeSet.of([{ from: 0, insert: "A new line.\n" }], p.state.doc.length));

const groupIn = (list: readonly AttachmentData[], id: string): AttachmentRecord | undefined => list.find((g) => g.id === id) as AttachmentRecord | undefined;

/** The original edits its own list and saves; the file then holds that list. */
async function originalSetsGroups(r: ReturnType<typeof rig>, list: AttachmentData[]): Promise<void> {
	inlineInk.setAttachments(N, list, true);
	await r.drain();
	expect(ids(r.groupsOnDisk()), "precondition: the original's groups reached the file").toEqual(ids(list));
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(async () => {
	await vi.advanceTimersByTimeAsync(4000);
	vi.useRealTimers();
	inlineInk.handleDelete(N);
	inlineInk.handleDelete(C);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("a group the copy only typed above is the file's at the clear", () => {
	it("the list mapped through typing, the original detaches the group: the copy holds no group, and nothing is written", async () => {
		const r = rig({ groups: [group("g0", ["p0"])] });
		await lockedCopyOpen();
		const typed = inlineInk.attachments(C).map((g) => ({ ...(g as AttachmentRecord), target: { ...(g as AttachmentRecord).target, from: (g as AttachmentRecord).target.from + 2, to: (g as AttachmentRecord).target.to + 2 } }));
		inlineInk.setAttachments(C, typed, false);
		await originalSetsGroups(r, []);
		const before = r.saves.length;

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect(ids(inlineInk.attachments(C)), "the copy kept the group the original detached").toEqual([]);
		expect(r.saves.length - before, "the clear wrote a list only mapped through typing").toBe(0);
		expect(r.groupsOnDisk(), "the file's groups changed").toEqual([]);
	});

	it("the list mapped through typing, the original adds a stroke to the group: the copy holds the file's members", async () => {
		const r = rig({ strokes: [stroke("p0", 5), stroke("t0", 60)], groups: [group("g0", ["p0"])] });
		await lockedCopyOpen();
		const typed = inlineInk.attachments(C).map((g) => ({ ...(g as AttachmentRecord), target: { ...(g as AttachmentRecord).target, from: (g as AttachmentRecord).target.from + 2, to: (g as AttachmentRecord).target.to + 2 } }));
		inlineInk.setAttachments(C, typed, false);
		await originalSetsGroups(r, [{ ...group("g0", ["p0", "t0"]) }]);

		await r.deleteOriginal();
		await r.drain();

		expect(groupIn(inlineInk.attachments(C), "g0")?.strokeIds, "the copy's older record beat the original's members").toEqual(["p0", "t0"]);
		expect(groupIn(r.groupsOnDisk(), "g0")?.strokeIds, "the file lost the original's members").toEqual(["p0", "t0"]);
	});

	it("a real line typed above the group in the copy's pane, the original detaches the group: no group in the copy or the file", async () => {
		const r = rig({ groups: [group("g0", ["p0"])] });
		await lockedCopyOpen();
		const p = pane(C, ["g0"]);
		typeLineAtTop(p);
		expect(p.follow.groupOffset("g0")?.dy, "precondition: the typed line moved the group's correction").toBe(LH);
		expect(groupIn(inlineInk.attachments(C), "g0")?.target.from, "precondition: the copy's list holds the mapped target").toBe(DOC.indexOf("benzene") + "A new line.\n".length);
		await originalSetsGroups(r, []);

		await r.deleteOriginal();
		await r.drain();

		expect(ids(inlineInk.attachments(C)), "the copy kept the group the original detached, from typing alone").toEqual([]);
		expect(ids(r.groupsOnDisk()), "the clear wrote back a group the original detached, from typing alone").toEqual([]);
	});

	it("one keystroke moves one group's correction and only maps another's target; the original edits the second: the file's second group", async () => {
		const r = rig({ strokes: [stroke("p0", 5), stroke("t0", 60, 70)], groups: [group("g1", ["p0"]), group("g2", ["t0"], "toluene")] });
		await lockedCopyOpen();
		const p = pane(C, ["g1"]);
		typeLineAtTop(p);
		expect(p.follow.groupOffset("g1")?.dy, "precondition: the keystroke moved g1's correction").toBe(LH);
		expect(groupIn(inlineInk.attachments(C), "g2")?.shown, "precondition: g2's correction did not move").toBeUndefined();
		await originalSetsGroups(r, inlineInk.attachments(N).map((g) => (g.id === "g2" ? moved(g, 20) : g)));

		await r.deleteOriginal();
		await r.drain();

		expect(groupIn(inlineInk.attachments(C), "g2")?.shown, "the copy's mapped g2 beat the original's edit of it").toEqual({ dx: 0, dy: 20 });
		expect(groupIn(r.groupsOnDisk(), "g2")?.shown, "the clear wrote the copy's mapped g2 over the original's edit").toEqual({ dx: 0, dy: 20 });
	});
});

describe("a group the copy acted on is the copy's at the clear", () => {
	it("re-attached to the same words at another place: the copy's group, over the original's move of it", async () => {
		const r = rig({ groups: [group("g0", ["p0"])] });
		await lockedCopyOpen();
		const p = pane(C);
		const again = group("g0", ["p0"], "benzene", 1);
		const { step } = attachGroup(inlineInk.attachments(C), again);
		expect(p.overlay.applyAttachSettle({ ...step!, path: C }, false, true), "precondition: the re-attach applied").toBe(true);
		await originalSetsGroups(r, inlineInk.attachments(N).map((g) => moved(g, 20)));

		await r.deleteOriginal();
		await r.drain();

		expect(groupIn(inlineInk.attachments(C), "g0")?.target.from, "the copy's re-attach was lost to the original's move").toBe(again.target.from);
		expect(groupIn(r.groupsOnDisk(), "g0")?.target.from, "the copy's re-attach did not reach the file at the clear").toBe(again.target.from);
	});

	it("detached in the copy's pane: no group in the copy, over the original's move of it", async () => {
		const r = rig({ groups: [group("g0", ["p0"])] });
		await lockedCopyOpen();
		const p = pane(C);
		const { step } = detachGroup(inlineInk.attachments(C), "g0");
		expect(p.overlay.applyAttachSettle({ ...step!, path: C }, false, true), "precondition: the Detach applied").toBe(true);
		await originalSetsGroups(r, inlineInk.attachments(N).map((g) => moved(g, 20)));

		await r.deleteOriginal();
		await r.drain();

		expect(ids(inlineInk.attachments(C)), "the copy's Detach was lost to the original's move").toEqual([]);
		expect(ids(r.groupsOnDisk()), "the copy's Detach did not reach the file at the clear").toEqual([]);
	});

	it("a member cut by the copy's eraser: the copy's group with its pieces, over the original's move of it", async () => {
		const r = rig({ strokes: [line("A")], groups: [group("g0", ["A"])] });
		await lockedCopyOpen();
		const taken = inlineInk.takeLive(C, ["A"]);
		const { stroke: a, index } = taken[0]!;
		inlineInk.reinsertLive(C, [{ index, pieces: splitStrokeByCircle(a, 110, 100, 14, newStrokeId), parent: "A" }]);
		const cut = groupIn(inlineInk.attachments(C), "g0")!.strokeIds;
		expect(cut.length, "precondition: the cut put A's pieces in the group").toBe(3);
		await originalSetsGroups(r, inlineInk.attachments(N).map((g) => moved(g, 20)));

		await r.deleteOriginal();
		await r.drain();

		expect(groupIn(inlineInk.attachments(C), "g0")?.strokeIds, "the copy's cut of a member was lost to the original's move").toEqual(cut);
	});

	it("edited and saved at one clear, then edited by the original under a second lock: the original's group at the second clear", async () => {
		const r = rig({ groups: [group("g0", ["p0"])] });
		await lockedCopyOpen();
		inlineInk.setAttachments(C, inlineInk.attachments(C).map((g) => moved(g, 20)), true);
		inlineInk.clearDuplicateLock(C);
		await r.drain();
		expect(groupIn(r.groupsOnDisk(), "g0")?.shown, "precondition: the first clear saved the copy's edit").toEqual({ dx: 0, dy: 20 });
		await inlineInk.reloadExternal(N);
		expect(groupIn(inlineInk.attachments(N), "g0")?.shown, "precondition: the original read the copy's edit").toEqual({ dx: 0, dy: 20 });
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked again").toBe(true);
		await originalSetsGroups(r, inlineInk.attachments(N).map((g) => moved(g, 40)));
		const before = r.saves.length;

		inlineInk.clearDuplicateLock(C);
		await r.drain();

		expect(groupIn(inlineInk.attachments(C), "g0")?.shown, "the copy's saved edit beat the original's later one").toEqual({ dx: 0, dy: 40 });
		expect(groupIn(r.groupsOnDisk(), "g0")?.shown, "the file lost the original's later edit").toEqual({ dx: 0, dy: 40 });
		expect(r.saves.length - before, "the second clear wrote with nothing of the copy's own").toBe(0);
	});
});

describe("a stroke the copy saved is the file's at a later clear", () => {
	// A whole erase leaves nothing of the stroke in the file, as a page that never held it does: the clear cannot tell the
	// two apart, and a saved stroke nobody erased is not lost. So the erased stroke comes back, once, as in 1.5.1.
	it("drawn and saved at one clear, erased whole by the original under a second lock: back once after the second clear, as in 1.5.1", async () => {
		const r = rig();
		await lockedCopyOpen();
		inlineInk.commit(C, stroke("s", 70));
		inlineInk.clearDuplicateLock(C);
		await r.drain();
		expect(r.onDisk(), "precondition: the first clear saved the copy's stroke").toEqual(["p0", "s"]);
		await inlineInk.reloadExternal(N);
		expect(ids(inlineInk.strokes(N)), "precondition: the original read the copy's stroke").toEqual(["p0", "s"]);
		inlineInk.markDuplicateLocked(C, N);
		inlineInk.applyRemove(N, ["s"]);
		inlineInk.save(N);
		await r.drain();
		expect(r.onDisk(), "precondition: the original's erase reached the file").toEqual(["p0"]);

		inlineInk.clearDuplicateLock(C);
		await r.drain();

		expect(ids(inlineInk.strokes(C)), "the copy's saved stroke is lost, or drawn twice").toEqual(["p0", "s"]);
		expect(r.onDisk(), "the file lost the copy's saved stroke, or holds it twice").toEqual(["p0", "s"]);
	});
});

describe("an Attach or a Detach made on a locked copy is in the file after the clear", () => {
	it("an Attach made the app's way, no stroke changed: the group is in the file, beside the original's later stroke", async () => {
		const r = rig();
		await lockedCopyOpen();
		inlineInk.commit(N, stroke("s1", 60, 70));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's stroke reached the file").toEqual(["p0", "s1"]);
		const p = pane(C);
		const before = r.saves.length;
		const { step } = attachGroup(inlineInk.attachments(C), group("g2", ["p0"]));
		expect(p.overlay.applyAttachSettle({ ...step!, path: C }, false, true), "precondition: the Attach applied").toBe(true);
		await r.drain();
		expect(r.saves.length - before, "precondition: the lock refused the Attach's save").toBe(0);

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect(ids(inlineInk.attachments(C)), "the open copy does not hold its group").toEqual(["g2"]);
		expect(ids(r.groupsOnDisk()), "the copy's Attach was not saved at the clear").toEqual(["g2"]);
		expect(r.onDisk(), "the clear lost a stroke").toEqual(["p0", "s1"]);
	});

	it("the original cut a stroke, then the copy attached it: the stroke whole, once, in the group, none of the original's pieces, in the copy and the file", async () => {
		const r = rig({ strokes: [line("A")] });
		await lockedCopyOpen();
		const taken = inlineInk.takeLive(N, ["A"]);
		const { stroke: a, index } = taken[0]!;
		inlineInk.reinsertLive(N, [{ index, pieces: splitStrokeByCircle(a, 110, 100, 14, newStrokeId), parent: "A" }]);
		inlineInk.save(N);
		await r.drain();
		expect(r.onDisk()?.length, "precondition: the original's cut of A reached the file").toBe(2);
		const p = pane(C);
		const { step } = attachGroup(inlineInk.attachments(C), group("g2", ["A"]));
		expect(p.overlay.applyAttachSettle({ ...step!, path: C }, false, true), "precondition: the Attach applied").toBe(true);

		await r.deleteOriginal();
		await r.drain();

		expect(ids(inlineInk.strokes(C)), "the copy does not hold A whole and once, or holds the original's pieces").toEqual(["A"]);
		expect(groupIn(inlineInk.attachments(C), "g2")?.strokeIds, "the copy's group lost A").toEqual(["A"]);
		expect(r.onDisk(), "the file does not hold A whole and once, or holds the original's pieces").toEqual(["A"]);
		expect(groupIn(r.groupsOnDisk(), "g2")?.strokeIds, "the file's group does not hold A").toEqual(["A"]);
	});

	it("an Attach through the lasso on the copy's pane: the group is in the file after the clear", async () => {
		const r = rig();
		await lockedCopyOpen();
		inlineInk.commit(N, stroke("s1", 60, 70));
		await r.drain();
		const p = attachPane(C);
		const before = r.saves.length;
		expect(await p.attach(["p0"]), "precondition: Attach is offered").toBe(true);
		const made = ids(inlineInk.attachments(C));
		expect(made.length, "precondition: the Attach made one group").toBe(1);
		expect(r.saves.length - before, "precondition: the lock refused the Attach's save").toBe(0);

		await r.deleteOriginal();
		await r.drain();

		expect(ids(r.groupsOnDisk()), "the lasso's Attach on the copy was not saved at the clear").toEqual(made);
		expect(r.onDisk(), "the clear lost a stroke").toEqual(["p0", "s1"]);
	});

	it("the clear's read throws with an Attach waiting: the note says at once its ink file could not be read yet", async () => {
		const r = rig();
		await lockedCopyOpen();
		const p = pane(C);
		const { step } = attachGroup(inlineInk.attachments(C), group("g2", ["p0"]));
		expect(p.overlay.applyAttachSettle({ ...step!, path: C }, false, true), "precondition: the Attach applied").toBe(true);
		r.throwNext();

		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);

		expect(inlineInk.isDamagedLocked(C), "precondition: the clear's read threw and holds the copy").toBe(true);
		expect(r.notices.filter((n) => n.includes("could not be read yet")), "the note was silent with an Attach not saved").toHaveLength(1);
	});
});

describe("a stroke the copy handed to a save that has not landed stays through a lock and its clear, once", () => {
	it("its write still queued when the copy is locked: the stroke stays, once, in the copy and the file", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		inlineInk.commit(C, stroke("c", 70));
		inlineInk.markDuplicateLocked(C, N);

		await r.deleteOriginal();
		await r.drain();

		expect(ids(inlineInk.strokes(C)), "the copy's queued stroke was dropped or doubled").toEqual(["p0", "c"]);
		expect(r.onDisk(), "the file lost the copy's queued stroke, or holds it twice").toEqual(["p0", "c"]);
	});

	it("its write failed when the copy is locked: the stroke stays, once, and reaches the file when writes work again", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		r.failWrites(true);
		inlineInk.commit(C, stroke("c", 70));
		await vi.advanceTimersByTimeAsync(8000);
		expect(r.onDisk(), "precondition: the copy's write failed").toEqual(["p0"]);
		inlineInk.markDuplicateLocked(C, N);

		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		r.failWrites(false);
		await r.drain();

		expect(ids(inlineInk.strokes(C)), "the copy's stroke whose write failed was dropped or doubled").toEqual(["p0", "c"]);
		expect(r.onDisk(), "the file lost the copy's stroke whose write failed, or holds it twice").toEqual(["p0", "c"]);
	});

	it("its queued write replaced by the original's save before it landed: the stroke stays, once, in the copy and the file", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		inlineInk.commit(C, stroke("c", 70));
		inlineInk.markDuplicateLocked(C, N);
		inlineInk.commit(N, stroke("o", 40));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's save took the queue before the copy's write landed").toEqual(["p0", "o"]);

		await r.deleteOriginal();
		await r.drain();

		expect(ids(inlineInk.strokes(C)), "the copy's stroke whose save never landed was dropped or doubled").toEqual(["p0", "o", "c"]);
		expect(r.onDisk(), "the file lost the copy's stroke whose save never landed, or holds it twice").toEqual(["p0", "o", "c"]);
	});
});

describe("a stroke the copy saved before its lock is kept when the original, open since before that save, saves again", () => {
	it("its write landed before the lock, the original drew and saved under the lock: the stroke stays, once, in the copy and the file", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		inlineInk.commit(C, stroke("c", 70));
		await r.drain();
		expect(r.onDisk(), "precondition: the copy's write landed before the lock").toEqual(["p0", "c"]);
		inlineInk.markDuplicateLocked(C, N);
		inlineInk.commit(N, stroke("o", 40));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's page, which never held the copy's stroke, replaced the file").toEqual(["p0", "o"]);

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect(ids(inlineInk.strokes(C)), "the clear dropped a stroke the copy saved and nobody erased").toEqual(["p0", "o", "c"]);
		expect(r.onDisk(), "the file lost a stroke the copy saved and nobody erased").toEqual(["p0", "o", "c"]);
	});

	it("attached to a word in a group of its own, saved with it: after the clear it is in that group, as the copy saved it, in the copy and the file", async () => {
		const r = rig();
		await bothOpen();
		inlineInk.commit(C, stroke("c", 70));
		inlineInk.setAttachments(C, [group("g2", ["c"])], false, true);
		inlineInk.save(C);
		await r.drain();
		const saved = groupIn(inlineInk.attachments(C), "g2");
		expect({ strokes: r.onDisk(), group: groupIn(r.groupsOnDisk(), "g2") }, "precondition: the copy's stroke and its group landed before the lock").toEqual({ strokes: ["p0", "c"], group: saved });
		inlineInk.markDuplicateLocked(C, N);
		inlineInk.commit(N, stroke("o", 40));
		await r.drain();
		expect({ strokes: r.onDisk(), groups: ids(r.groupsOnDisk()) }, "precondition: the original's page, which never held the copy's stroke or group, replaced the file").toEqual({ strokes: ["p0", "o"], groups: [] });

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect({ strokes: ids(inlineInk.strokes(C)), group: groupIn(inlineInk.attachments(C), "g2") }, "the copy's kept stroke left its group, or the group is not as the copy saved it").toEqual({ strokes: ["p0", "o", "c"], group: saved });
		expect({ strokes: r.onDisk(), group: groupIn(r.groupsOnDisk(), "g2") }, "the file holds the copy's kept stroke without its group, or the group not as the copy saved it").toEqual({ strokes: ["p0", "o", "c"], group: saved });
	});

	it("added to a group both notes hold, saved with it: after the clear that group holds it, in the copy and the file", async () => {
		const r = rig({ groups: [group("g0", ["p0"])] });
		await bothOpen();
		inlineInk.commit(C, stroke("c", 70));
		inlineInk.setAttachments(C, [{ ...groupIn(inlineInk.attachments(C), "g0")!, strokeIds: ["p0", "c"] }], false, true);
		inlineInk.save(C);
		await r.drain();
		expect({ strokes: r.onDisk(), members: groupIn(r.groupsOnDisk(), "g0")?.strokeIds }, "precondition: the copy's stroke and its place in the group landed before the lock").toEqual({ strokes: ["p0", "c"], members: ["p0", "c"] });
		inlineInk.markDuplicateLocked(C, N);
		inlineInk.commit(N, stroke("o", 40));
		await r.drain();
		expect({ strokes: r.onDisk(), members: groupIn(r.groupsOnDisk(), "g0")?.strokeIds }, "precondition: the original's page, which never held the copy's stroke, replaced the file").toEqual({ strokes: ["p0", "o"], members: ["p0"] });

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect({ strokes: ids(inlineInk.strokes(C)), members: groupIn(inlineInk.attachments(C), "g0")?.strokeIds }, "the copy's kept stroke left the group it saved it in").toEqual({ strokes: ["p0", "o", "c"], members: ["p0", "c"] });
		expect({ strokes: r.onDisk(), members: groupIn(r.groupsOnDisk(), "g0")?.strokeIds }, "the file holds the copy's kept stroke outside the group it was saved in").toEqual({ strokes: ["p0", "o", "c"], members: ["p0", "c"] });
	});

	// Typing on either side maps the group's target in that side's list: the two records then differ in offsets alone,
	// which place nothing (a pane finds the target again by its words), and the stroke still joins the group. The group is
	// on the second "benzene", so the word typed at the top is outside its 32 characters of context.
	it.each([
		{ side: "the copy, locked", typist: C },
		{ side: "the original", typist: N },
	])("added to a group both notes hold, saved with it, then a word typed on a line above that group by $side: after the clear that group holds it, in the copy and the file", async ({ typist }) => {
		const r = rig({ groups: [group("g0", ["p0"], "benzene", 1)] });
		await bothOpen();
		inlineInk.commit(C, stroke("c", 70));
		inlineInk.setAttachments(C, [{ ...groupIn(inlineInk.attachments(C), "g0")!, strokeIds: ["p0", "c"] }], false, true);
		inlineInk.save(C);
		await r.drain();
		expect({ strokes: r.onDisk(), members: groupIn(r.groupsOnDisk(), "g0")?.strokeIds }, "precondition: the copy's stroke and its place in the group landed before the lock").toEqual({ strokes: ["p0", "c"], members: ["p0", "c"] });
		inlineInk.markDuplicateLocked(C, N);
		const p = pane(typist, ["g0"]);
		p.type(ChangeSet.of([{ from: 0, insert: "Big " }], p.state.doc.length));
		const g0 = groupIn(inlineInk.attachments(typist), "g0")!;
		expect({ from: g0.target.from, before: g0.target.before }, "precondition: the word typed mapped the group's target in that note's list, its context unchanged").toEqual({ from: DOC.lastIndexOf("benzene") + "Big ".length, before: group("g0", ["p0"], "benzene", 1).target.before });
		inlineInk.commit(N, stroke("o", 40));
		await r.drain();
		expect({ strokes: r.onDisk(), members: groupIn(r.groupsOnDisk(), "g0")?.strokeIds }, "precondition: the original's page, which never held the copy's stroke, replaced the file").toEqual({ strokes: ["p0", "o"], members: ["p0"] });

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect({ strokes: ids(inlineInk.strokes(C)), members: groupIn(inlineInk.attachments(C), "g0")?.strokeIds }, "the copy's kept stroke left the group it saved it in, the records differing in offsets only").toEqual({ strokes: ["p0", "o", "c"], members: ["p0", "c"] });
		expect({ strokes: r.onDisk(), members: groupIn(r.groupsOnDisk(), "g0")?.strokeIds }, "the file holds the copy's kept stroke outside the group it was saved in, the records differing in offsets only").toEqual({ strokes: ["p0", "o", "c"], members: ["p0", "c"] });
	});

	it("in a group of its own, read by the original, which erased it whole under the lock: it comes back in that group, as the copy saved it, in the copy and the file", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		inlineInk.setAttachments(C, inlineInk.attachments(C), false);
		inlineInk.commit(C, stroke("c", 70));
		inlineInk.setAttachments(C, [group("g2", ["c"])], false, true);
		inlineInk.save(C);
		await r.drain();
		const saved = groupIn(inlineInk.attachments(C), "g2");
		expect({ strokes: r.onDisk(), group: groupIn(r.groupsOnDisk(), "g2") }, "precondition: the copy's stroke and its group landed").toEqual({ strokes: ["p0", "c"], group: saved });
		await inlineInk.ensureLoaded(N);
		inlineInk.setAttachments(N, inlineInk.attachments(N), false);
		expect({ strokes: ids(inlineInk.strokes(N)), groups: ids(inlineInk.attachments(N)) }, "precondition: the original read the copy's save").toEqual({ strokes: ["p0", "c"], groups: ["g2"] });
		inlineInk.markDuplicateLocked(C, N);
		// The whole erase as the pane makes it: the stroke taken, its group left with no member removed, then the save.
		inlineInk.takeLive(N, ["c"]);
		inlineInk.setAttachments(N, [], false, true);
		inlineInk.save(N);
		await r.drain();
		expect({ strokes: r.onDisk(), groups: ids(r.groupsOnDisk()) }, "precondition: the original's whole erase replaced the file").toEqual({ strokes: ["p0"], groups: [] });

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect({ strokes: ids(inlineInk.strokes(C)), group: groupIn(inlineInk.attachments(C), "g2") }, "the stroke came back without its group, or the group is not as the copy saved it").toEqual({ strokes: ["p0", "c"], group: saved });
		expect({ strokes: r.onDisk(), group: groupIn(r.groupsOnDisk(), "g2") }, "the file holds the stroke that came back without its group").toEqual({ strokes: ["p0", "c"], group: saved });
	});

	it("in a group of its own beside a stroke the file holds, saved with it: after the clear that group holds the kept stroke only, as the copy saved it otherwise, in the copy and the file", async () => {
		const r = rig();
		await bothOpen();
		inlineInk.commit(C, stroke("c", 70));
		inlineInk.setAttachments(C, [group("g2", ["p0", "c"])], false, true);
		inlineInk.save(C);
		await r.drain();
		const saved = groupIn(inlineInk.attachments(C), "g2")!;
		expect({ strokes: r.onDisk(), group: groupIn(r.groupsOnDisk(), "g2") }, "precondition: the copy's stroke and its group landed before the lock").toEqual({ strokes: ["p0", "c"], group: saved });
		inlineInk.markDuplicateLocked(C, N);
		inlineInk.commit(N, stroke("o", 40));
		await r.drain();
		expect({ strokes: r.onDisk(), groups: ids(r.groupsOnDisk()) }, "precondition: the original's page, which never held the copy's stroke or group, replaced the file").toEqual({ strokes: ["p0", "o"], groups: [] });

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		const kept = { ...saved, strokeIds: ["c"] };
		expect({ strokes: ids(inlineInk.strokes(C)), group: groupIn(inlineInk.attachments(C), "g2") }, "the copy's group is gone, or holds a stroke the file holds, or is not as the copy saved it").toEqual({ strokes: ["p0", "o", "c"], group: kept });
		expect({ strokes: r.onDisk(), group: groupIn(r.groupsOnDisk(), "g2") }, "the file's group is gone, or holds a stroke the file holds, or is not as the copy saved it").toEqual({ strokes: ["p0", "o", "c"], group: kept });
	});

	it("in a group of its own, read by the original, which detached the group and saved: no group after the clear, and the stroke as the file holds it, in the copy and the file", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		inlineInk.setAttachments(C, inlineInk.attachments(C), false);
		inlineInk.commit(C, stroke("c", 70));
		inlineInk.setAttachments(C, [group("g2", ["c"])], false, true);
		inlineInk.save(C);
		await r.drain();
		await inlineInk.ensureLoaded(N);
		inlineInk.setAttachments(N, inlineInk.attachments(N), false);
		expect({ strokes: ids(inlineInk.strokes(N)), groups: ids(inlineInk.attachments(N)) }, "precondition: the original read the copy's save").toEqual({ strokes: ["p0", "c"], groups: ["g2"] });
		inlineInk.markDuplicateLocked(C, N);
		// The Detach as the store takes it: the member baked to where it is shown, the group gone, acted on, then the save.
		inlineInk.moveStrokes(N, ["c"], 0, 30);
		inlineInk.setAttachments(N, [], false, true);
		inlineInk.save(N);
		await r.drain();
		const filePage = () => parsePage(r.fake.files.get(FILE)!, X).data;
		expect({ groups: ids(r.groupsOnDisk()), y: yIn(filePage().strokes, "c") }, "precondition: the original's Detach replaced the file").toEqual({ groups: [], y: 70 });

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect({ strokes: ids(inlineInk.strokes(C)), groups: ids(inlineInk.attachments(C)), y: yIn(inlineInk.strokes(C), "c") }, "the group the original detached came back, or the copy holds its own older stroke").toEqual({ strokes: ["p0", "c"], groups: [], y: 70 });
		expect({ strokes: r.onDisk(), groups: ids(r.groupsOnDisk()), y: yIn(filePage().strokes, "c") }, "the file holds the group the original detached, or the copy's older stroke").toEqual({ strokes: ["p0", "c"], groups: [], y: 70 });
	});

	it.each([
		{ by: "a reopen", heal: (): Promise<unknown> => inlineInk.ensureLoaded(C) },
		{ by: "the sync poll's adoption", heal: (): Promise<unknown> => inlineInk.adoptExternal(C, () => true) },
	])("in a group of its own, saved with it, the clear's read throwing: healed by $by, it is in that group, as the copy saved it, in the copy and the file", async ({ heal }) => {
		const r = rig();
		await bothOpen();
		inlineInk.commit(C, stroke("c", 70));
		inlineInk.setAttachments(C, [group("g2", ["c"])], false, true);
		inlineInk.save(C);
		await r.drain();
		const saved = groupIn(inlineInk.attachments(C), "g2");
		expect({ strokes: r.onDisk(), group: groupIn(r.groupsOnDisk(), "g2") }, "precondition: the copy's stroke and its group landed before the lock").toEqual({ strokes: ["p0", "c"], group: saved });
		inlineInk.markDuplicateLocked(C, N);
		inlineInk.commit(N, stroke("o", 40));
		await r.drain();
		expect({ strokes: r.onDisk(), groups: ids(r.groupsOnDisk()) }, "precondition: the original's page, which never held the copy's stroke or group, replaced the file").toEqual({ strokes: ["p0", "o"], groups: [] });
		r.throwNext();
		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDamagedLocked(C), "precondition: the clear's read threw and holds the copy").toBe(true);

		await heal();
		await r.drain();

		expect(inlineInk.isDamagedLocked(C), "precondition: the read healed").toBe(false);
		expect({ strokes: ids(inlineInk.strokes(C)), group: groupIn(inlineInk.attachments(C), "g2") }, "the heal left the copy's kept stroke out of its group, or the group not as the copy saved it").toEqual({ strokes: ["p0", "o", "c"], group: saved });
		expect({ strokes: r.onDisk(), group: groupIn(r.groupsOnDisk(), "g2") }, "the heal wrote the copy's kept stroke without its group, or the group not as the copy saved it").toEqual({ strokes: ["p0", "o", "c"], group: saved });
	});
});

type FilePage = ReturnType<typeof parsePage>["data"];

/**
 * Every page written toward the shared file (its scratch file included), parsed, in order. The spy goes on before rig(),
 * which binds the adapter's write when it is built; a write the rig fails never reaches it.
 */
function pagesWritten(): () => FilePage[] {
	const write = FakeAdapter.prototype.write;
	const written: string[] = [];
	vi.spyOn(FakeAdapter.prototype, "write").mockImplementation(async function (this: FakeAdapter, path: string, data: string) {
		await write.call(this, path, data);
		if (path.startsWith(FILE)) written.push(data);
	});
	return () => written.map((t) => parsePage(t, X).data);
}

/** Both notes open on the shared page, neither locked, their lists resolved as an open note's resolve does. */
async function bothOpen(): Promise<void> {
	await inlineInk.ensureLoaded(C);
	await inlineInk.ensureLoaded(N);
	for (const p of [C, N]) inlineInk.setAttachments(p, inlineInk.attachments(p), false);
}

const yIn = (list: readonly InkStroke[], id: string): number | undefined => list.find((s) => s.id === id)?.points[0]?.y;

/** The two queue orders in which the original's save takes the place of the copy's last save before that one lands. */
const orders = [
	{ order: "inside the copy's 700 ms wait", failFirst: false },
	{ order: "after the copy's write failed, before its retry", failFirst: true },
];

/**
 * The copy runs `act`, which saves; the copy is locked; the original draws o and saves, and its page takes the queue
 * before the copy's lands: at the same moment, inside the copy's wait, or once the copy's write has failed. Then writes
 * work and everything drains.
 */
async function copySavesThenOriginalTakesTheQueue(r: ReturnType<typeof rig>, failFirst: boolean, act: () => void): Promise<void> {
	if (failFirst) r.failWrites(true);
	act();
	if (failFirst) {
		await vi.advanceTimersByTimeAsync(8000);
		expect(r.onDisk(), "precondition: the copy's write failed").toEqual(["p0"]);
	}
	inlineInk.markDuplicateLocked(C, N);
	expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
	inlineInk.commit(N, stroke("o", 40));
	r.failWrites(false);
	await r.drain();
	expect(r.onDisk(), "precondition: the original's page took the queue").toEqual(["p0", "o"]);
}

describe.each(orders)("a group the copy acted on and saved, the original's save taking the queue $order", ({ failFirst }) => {
	it("a Detach of a group shown off its words: no group, and the stroke where the Detach left it, in the copy and the file", async () => {
		const seen = pagesWritten();
		const r = rig({ groups: [group("g0", ["p0"], "benzene", 0, { dx: 0, dy: 30 })] });
		await bothOpen();
		expect(groupIn(inlineInk.attachments(C), "g0")?.shown, "precondition: the group is shown off its words").toEqual({ dx: 0, dy: 30 });
		expect(yIn(inlineInk.strokes(C), "p0"), "precondition: the member is stored at y 40").toBe(40);
		// The Detach as the store takes it: the member baked to where it is shown, the group gone, acted on, then the save.
		await copySavesThenOriginalTakesTheQueue(r, failFirst, () => {
			inlineInk.moveStrokes(C, ["p0"], 0, 30);
			inlineInk.setAttachments(C, [], false, true);
			inlineInk.save(C);
		});
		const pages = seen();
		expect(pages.length, "precondition: the original's page was written").toBeGreaterThan(0);
		expect(pages.filter((p) => groupIn(p.attachments ?? [], "g0") === undefined || yIn(p.strokes, "p0") !== 40), "precondition: a page with the copy's Detach reached the file").toEqual([]);

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect({ groups: ids(inlineInk.attachments(C)), y: yIn(inlineInk.strokes(C), "p0") }, "the copy's Detach was forgotten, or its ink moved off by the group's correction").toEqual({ groups: [], y: 70 });
		const file = { groups: ids(r.groupsOnDisk()), y: yIn(parsePage(r.fake.files.get(FILE)!, X).data.strokes, "p0") };
		expect(file, "the file holds the group the copy detached, or its ink moved off by the group's correction").toEqual({ groups: [], y: 70 });
	});

	it("an Attach: the group is in the copy and the file", async () => {
		const seen = pagesWritten();
		const r = rig();
		await bothOpen();
		await copySavesThenOriginalTakesTheQueue(r, failFirst, () => {
			inlineInk.setAttachments(C, [group("g2", ["p0"])], false, true);
			inlineInk.save(C);
		});
		const pages = seen();
		expect(pages.length, "precondition: the original's page was written").toBeGreaterThan(0);
		expect(pages.filter((p) => groupIn(p.attachments ?? [], "g2") !== undefined), "precondition: a page with the copy's Attach reached the file").toEqual([]);

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect(ids(inlineInk.attachments(C)), "the copy's Attach was forgotten at the clear").toEqual(["g2"]);
		expect(ids(r.groupsOnDisk()), "the file lost the copy's Attach").toEqual(["g2"]);
	});
});

describe("a read that fails at the clear leaves the group merge owed", () => {
	/** The copy loaded g0 on p0 and did nothing; the original drew t0, attached g2 to it, and saved, while the copy was locked. */
	async function originalAddedGroup(r: ReturnType<typeof rig>): Promise<void> {
		await lockedCopyOpen();
		inlineInk.commit(N, stroke("t0", 60, 70));
		await originalSetsGroups(r, [...inlineInk.attachments(N), group("g2", ["t0"], "toluene")]);
		expect(r.onDisk(), "precondition: the original's stroke reached the file").toEqual(["p0", "t0"]);
	}

	it("healed by a reopen: the file's groups, and nothing written", async () => {
		const r = rig({ groups: [group("g0", ["p0"])] });
		await originalAddedGroup(r);
		const before = r.saves.length;
		r.throwNext();
		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDamagedLocked(C), "precondition: the clear's read threw and holds the copy").toBe(true);

		await inlineInk.ensureLoaded(C);
		await r.drain();

		expect(inlineInk.isDamagedLocked(C), "precondition: the read healed").toBe(false);
		expect(ids(inlineInk.attachments(C)), "the heal kept the copy's older list").toEqual(["g0", "g2"]);
		expect(r.saves.length - before, "the heal wrote for a copy with nothing of its own").toBe(0);
		expect(ids(r.groupsOnDisk()), "the heal wrote the copy's older list over the file's").toEqual(["g0", "g2"]);
	});

	it("healed by the sync poll's adoption: the file's groups, and nothing written", async () => {
		const r = rig({ groups: [group("g0", ["p0"])] });
		await originalAddedGroup(r);
		const before = r.saves.length;
		r.throwNext();
		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDamagedLocked(C), "precondition: the clear's read threw and holds the copy").toBe(true);

		const adopted = await inlineInk.adoptExternal(C, () => true);
		await r.drain();

		expect(adopted.outcome, "precondition: the poll's adoption healed the copy").toBe("adopted");
		expect(ids(inlineInk.attachments(C)), "the heal kept the copy's older list").toEqual(["g0", "g2"]);
		expect(r.saves.length - before, "the heal wrote for a copy with nothing of its own").toBe(0);
		expect(ids(r.groupsOnDisk()), "the heal wrote the copy's older list over the file's").toEqual(["g0", "g2"]);
	});

	it("a second read that fails keeps the merge owed to the read that lands", async () => {
		const r = rig({ groups: [group("g0", ["p0"])] });
		await originalAddedGroup(r);
		const before = r.saves.length;
		r.throwNext();
		await r.deleteOriginal();
		await r.drain();
		r.throwNext();
		await inlineInk.ensureLoaded(C);
		await r.drain();
		expect(inlineInk.isDamagedLocked(C), "precondition: the second read threw too").toBe(true);

		await inlineInk.ensureLoaded(C);
		await r.drain();

		expect(inlineInk.isDamagedLocked(C), "precondition: the third read healed").toBe(false);
		expect(ids(inlineInk.attachments(C)), "the heal kept the copy's older list").toEqual(["g0", "g2"]);
		expect(r.saves.length - before, "a heal wrote for a copy with nothing of its own").toBe(0);
	});

	it("a group the copy edited while locked: the copy's edit and the original's new group, written once at the heal", async () => {
		const r = rig({ groups: [group("g0", ["p0"])] });
		await originalAddedGroup(r);
		inlineInk.setAttachments(C, inlineInk.attachments(C).map((g) => moved(g, 20)), true);
		r.throwNext();
		await r.deleteOriginal();
		await r.drain();
		const before = r.saves.length;

		await inlineInk.ensureLoaded(C);
		await r.drain();

		expect(ids(inlineInk.attachments(C)), "the heal lost the original's group or the copy's").toEqual(["g0", "g2"]);
		expect(groupIn(r.groupsOnDisk(), "g0")?.shown, "the copy's edit was not saved at the heal").toEqual({ dx: 0, dy: 20 });
		expect(ids(r.groupsOnDisk()), "the file lost the original's group").toEqual(["g0", "g2"]);
		expect(r.saves.length - before, "the heal did not write the copy's edit once").toBe(1);
	});

	it("an Attach the copy saved, its page replaced in the queue by the original's: healed by a reopen, the Attach is in the copy and the file", async () => {
		const r = rig();
		await bothOpen();
		await copySavesThenOriginalTakesTheQueue(r, false, () => {
			inlineInk.setAttachments(C, [group("g2", ["p0"])], false, true);
			inlineInk.save(C);
		});
		expect(ids(r.groupsOnDisk()), "precondition: the copy's Attach is not in the file").toEqual([]);
		r.throwNext();
		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		expect(inlineInk.isDamagedLocked(C), "precondition: the clear's read threw and holds the copy").toBe(true);
		await r.drain();

		await inlineInk.ensureLoaded(C);
		await r.drain();

		expect(inlineInk.isDamagedLocked(C), "precondition: the read healed").toBe(false);
		expect({ copy: ids(inlineInk.attachments(C)), file: ids(r.groupsOnDisk()) }, "the heal lost the copy's Attach, or did not write it").toEqual({ copy: ["g2"], file: ["g2"] });
	});

	it("the file gone by the heal: every group the copy holds is kept, and its page is saved whole", async () => {
		const r = rig({ groups: [group("g0", ["p0"])] });
		await lockedCopyOpen();
		r.throwNext();
		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDamagedLocked(C), "precondition: the clear's read threw and holds the copy").toBe(true);
		r.fake.files.delete(FILE);

		await inlineInk.ensureLoaded(C);
		await r.drain();

		expect(ids(inlineInk.attachments(C)), "the heal dropped a group the copy holds").toEqual(["g0"]);
		expect(r.onDisk(), "the copy's page was not saved whole").toEqual(["p0"]);
		expect(ids(r.groupsOnDisk()), "the copy's page was saved without its group").toEqual(["g0"]);
	});

	it("locked again before the heal: the poll's adoption holds, and nothing is written", async () => {
		const r = rig({ groups: [group("g0", ["p0"])] });
		await originalAddedGroup(r);
		r.throwNext();
		await r.deleteOriginal();
		await r.drain();
		inlineInk.markDuplicateLocked(C, "Original 2.md");
		const before = r.saves.length;

		const adopted = await inlineInk.adoptExternal(C, () => true);
		await r.drain();

		expect(adopted.outcome, "a copy locked again was healed by the poll").toBe("held");
		expect(r.saves.length - before, "a copy locked again was written").toBe(0);
		expect(ids(r.groupsOnDisk()), "the file's groups changed").toEqual(["g0", "g2"]);
	});
});

/**
 * A group both notes hold. The copy adds its stroke c to it and saves, and the save lands; the original, open since
 * before that save, then changes that group's record another way than its members, and saves. At the clear c is kept as
 * the copy's. One record carries one follow, so c cannot join the file's record and still show where it showed: it stays
 * in the copy's record, pruned to c, under an id of its own, and the file's group keeps its members. Each stroke is in one
 * group, shows where it showed on the copy, and follows its own words.
 */
describe("a stroke the copy saved into a group both notes hold, whose record the original then changed", () => {
	const holding = (list: readonly AttachmentData[], id: string): AttachmentRecord[] =>
		list.filter((a): a is AttachmentRecord => "strokeIds" in a && a.strokeIds.includes(id));
	/** Where stroke `id` shows on the copy's pane over DOC: its stored point moved by its group's follow, if it is in one. */
	const shownY = (list: readonly AttachmentData[], strokes: readonly InkStroke[], id: string): number => {
		const y = yIn(strokes, id)!;
		const g = holding(list, id)[0];
		return g ? y + topAt(DOC, g.target.from) - g.ref.y : y;
	};
	const filePage = (r: ReturnType<typeof rig>) => parsePage(r.fake.files.get(FILE)!, X).data;

	/** g0 holds p0 in both notes; the copy adds c to it the app's way and saves, landed; then the copy is locked. */
	async function copyAddsToSharedGroup(r: ReturnType<typeof rig>): Promise<{ step: AttachStep; p: ReturnType<typeof pane>; saved: AttachmentRecord; shown: { c: number; p0: number } }> {
		await bothOpen();
		inlineInk.commit(C, stroke("c", 70));
		const { step } = attachGroup(inlineInk.attachments(C), { ...groupIn(inlineInk.attachments(C), "g0")!, strokeIds: ["p0", "c"] });
		const p = pane(C);
		expect(p.overlay.applyAttachSettle({ ...step!, path: C }, false, true), "precondition: the copy's Attach applied").toBe(true);
		inlineInk.save(C);
		await r.drain();
		const saved = groupIn(inlineInk.attachments(C), "g0")!;
		expect({ strokes: r.onDisk(), group: groupIn(r.groupsOnDisk(), "g0") }, "precondition: c and its place in g0 landed before the lock").toEqual({ strokes: ["p0", "c"], group: saved });
		const shown = { c: shownY(inlineInk.attachments(C), inlineInk.strokes(C), "c"), p0: shownY(inlineInk.attachments(C), inlineInk.strokes(C), "p0") };
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		return { step: step!, p, saved, shown };
	}

	/** After the clear, in `list` over `strokes`: c in one group, the copy's record under its own id; p0 in one, the file's g0. */
	function eachInItsOwn(where: string, list: readonly AttachmentData[], strokes: readonly InkStroke[], saved: AttachmentRecord, fileG0: AttachmentRecord, shown: { c: number; p0: number }): void {
		const ofC = holding(list, "c"), ofP0 = holding(list, "p0");
		expect({ c: ofC.length, p0: ofP0.length }, `${where}: a stroke is in no group, or in two`).toEqual({ c: 1, p0: 1 });
		expect(ofC[0]!.id === "g0" || list.filter((a) => a.id === ofC[0]!.id).length !== 1, `${where}: c's group does not have an id of its own`).toBe(false);
		expect({ c: { ...ofC[0]!, id: "-" }, p0: ofP0[0] }, `${where}: c is not in the copy's record pruned to it, or p0 not in the file's g0`).toEqual({ c: { ...saved, id: "-", strokeIds: ["c"] }, p0: fileG0 });
		expect({ c: shownY(list, strokes, "c"), p0: shownY(list, strokes, "p0") }, `${where}: a stroke is drawn off where it showed on the copy`).toEqual(shown);
	}

	it("the original changed the group's attachment to another word and saved: c in the copy's record under its own id, p0 in the file's g0, each where it showed", async () => {
		const r = rig({ groups: [group("g0", ["p0"])] });
		const { saved, shown } = await copyAddsToSharedGroup(r);
		await originalSetsGroups(r, [group("g0", ["p0"], "toluene")]);
		const fileG0 = groupIn(r.groupsOnDisk(), "g0")!;
		expect({ strokes: r.onDisk(), word: fileG0.target.text, members: fileG0.strokeIds }, "precondition: the original's re-attached g0, without c, replaced the file").toEqual({ strokes: ["p0"], word: "toluene", members: ["p0"] });

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect(ids(inlineInk.strokes(C)), "the copy lost c or p0").toEqual(["p0", "c"]);
		eachInItsOwn("the copy", inlineInk.attachments(C), inlineInk.strokes(C), saved, fileG0, shown);
		eachInItsOwn("the file", r.groupsOnDisk(), filePage(r).strokes, saved, fileG0, shown);
	});

	it("the original used Insert Space above the group, which moved its record and p0 down, and saved: c in the copy's record under its own id, p0 in the file's g0, each where it showed", async () => {
		const r = rig({ groups: [group("g0", ["p0"])] });
		const { saved, shown } = await copyAddsToSharedGroup(r);
		// As Insert Space writes a group its text change does not move: the members and the record's reference point and
		// probe moved by the same dy.
		const g0 = groupIn(inlineInk.attachments(N), "g0")!;
		inlineInk.moveStrokes(N, ["p0"], 0, 30);
		await originalSetsGroups(r, [{ ...g0, ref: { ...g0.ref, y: g0.ref.y + 30 }, probe: { ...g0.probe, y: g0.probe.y + 30 } }]);
		const fileG0 = groupIn(r.groupsOnDisk(), "g0")!;
		expect({ strokes: r.onDisk(), ref: fileG0.ref.y - saved.ref.y, p0: yIn(filePage(r).strokes, "p0") }, "precondition: the original's moved g0 and p0, without c, replaced the file").toEqual({ strokes: ["p0"], ref: 30, p0: 70 });

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect(ids(inlineInk.strokes(C)), "the copy lost c or p0").toEqual(["p0", "c"]);
		eachInItsOwn("the copy", inlineInk.attachments(C), inlineInk.strokes(C), saved, fileG0, shown);
		eachInItsOwn("the file", r.groupsOnDisk(), filePage(r).strokes, saved, fileG0, shown);
	});

	it("after that clear, an undo of the copy's Attach: each stroke in one group at most, where it showed", async () => {
		const r = rig({ groups: [group("g0", ["p0"])] });
		const { step, p } = await copyAddsToSharedGroup(r);
		await originalSetsGroups(r, [group("g0", ["p0"], "toluene")]);
		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);
		const shown = { c: shownY(inlineInk.attachments(C), inlineInk.strokes(C), "c"), p0: shownY(inlineInk.attachments(C), inlineInk.strokes(C), "p0") };

		p.overlay.applyAttachSettle({ ...invertAttachStep(step), path: C });
		await r.drain();

		const list = inlineInk.attachments(C);
		expect({ c: holding(list, "c").length <= 1, p0: holding(list, "p0").length <= 1 }, "after the undo a stroke is in two groups").toEqual({ c: true, p0: true });
		expect({ c: shownY(list, inlineInk.strokes(C), "c"), p0: shownY(list, inlineInk.strokes(C), "p0") }, "the undo drew a stroke off where it showed").toEqual(shown);
	});
});

/**
 * One stroke, two groups, at the clear. The original attaches a stroke to one word and saves; the copy, locked, attaches the
 * same stroke to another word the app's way. At the clear the copy's group keeps the stroke: a stroke in a group the copy
 * acted on and in one it did not leaves the one it did not, trimmed as a load trims, that group dropped only when left with
 * no stroke. An opaque group (a newer build's) and a file's own two groups on one stroke are left as they are, and a load
 * changes no list. In the copy and the file alike each stroke is then in one readable group, and an undo or a redo of the
 * copy's Attach after the clear leaves it in one group at most.
 */
describe("a stroke the original attached to one word and the locked copy to another", () => {
	const holding = (list: readonly AttachmentData[], id: string): string[] =>
		list.filter((a): a is AttachmentRecord => "strokeIds" in a && a.strokeIds.includes(id)).map((a) => a.id);
	const yOf = (strokes: readonly InkStroke[], id: string): number | undefined => strokes.find((s) => s.id === id)?.points[0]?.y;

	/** The original attaches `fileGroup` and saves; then the copy, locked, attaches p0 to the word "toluene" as g2. */
	async function bothAttach(r: ReturnType<typeof rig>, fileGroup: AttachmentRecord): Promise<{ step: AttachStep; p: ReturnType<typeof pane> }> {
		await lockedCopyOpen();
		await originalSetsGroups(r, [fileGroup]);
		const p = pane(C);
		const { step } = attachGroup(inlineInk.attachments(C), group("g2", ["p0"], "toluene"));
		expect(p.overlay.applyAttachSettle({ ...step!, path: C }, false, true), "precondition: the copy's Attach applied").toBe(true);
		return { step: step!, p };
	}

	async function clear(r: ReturnType<typeof rig>): Promise<void> {
		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);
	}

	it("the original's group holds only that stroke: the copy's group keeps it, and the original's, left with none, goes, in the copy and the file", async () => {
		const r = rig();
		await bothAttach(r, group("g1", ["p0"]));
		const y = yOf(inlineInk.strokes(C), "p0");

		await clear(r);

		expect.soft(holding(r.groupsOnDisk(), "p0"), "the file holds the stroke in two groups, or not in the copy's").toEqual(["g2"]);
		expect.soft(holding(inlineInk.attachments(C), "p0"), "the copy holds the stroke in two groups, or not in its own").toEqual(["g2"]);
		expect.soft(ids(r.groupsOnDisk()), "the original's group left with no stroke is still in the file").toEqual(["g2"]);
		expect.soft(attachmentMembership(inlineInk.attachments(C)), "the copy's screen and the file name another group for a stroke").toEqual(attachmentMembership(r.groupsOnDisk()));
		expect.soft(groupIn(r.groupsOnDisk(), "g2")?.target.text, "the copy's group is not on its own word in the file").toBe("toluene");
		expect.soft(yOf(inlineInk.strokes(C), "p0"), "the stroke moved at the clear").toBe(y);
		expect.soft(r.onDisk(), "the clear lost a stroke").toEqual(["p0"]);
	});

	it("the original's group holds another stroke too: that group keeps the other stroke on its word, the copy's keeps the shared one", async () => {
		const r = rig({ strokes: [stroke("p0", 5), stroke("t", 80)] });
		await bothAttach(r, group("g1", ["p0", "t"]));

		await clear(r);

		for (const [where, list] of [["the file", r.groupsOnDisk()], ["the copy", inlineInk.attachments(C)]] as const) {
			expect.soft(holding(list, "p0"), `${where} holds the shared stroke in two groups, or not in the copy's`).toEqual(["g2"]);
			expect.soft(holding(list, "t"), `${where} lost the original's group for its other stroke`).toEqual(["g1"]);
			expect.soft(groupIn(list, "g1")?.target.text, `${where}: the original's group is not on its word`).toBe("benzene");
		}
		expect.soft(r.onDisk(), "the clear lost a stroke").toEqual(["p0", "t"]);
	});

	it("an opaque group in the file holds the stroke too: it stays as it was, and the readable groups are judged without it", async () => {
		const r = rig();
		const raw = JSON.parse(r.fake.files.get(FILE)!) as { attachments?: Record<string, unknown>[] };
		const future = { v: 2, id: "gx", strokeIds: ["p0"], kind: "a newer build's" };
		raw.attachments = [...(raw.attachments ?? []), future];
		r.fake.files.set(FILE, JSON.stringify(raw));
		await lockedCopyOpen();
		await originalSetsGroups(r, [...inlineInk.attachments(N), group("g1", ["p0"])]);
		const p = pane(C);
		const { step } = attachGroup(inlineInk.attachments(C), group("g2", ["p0"], "toluene"));
		expect(p.overlay.applyAttachSettle({ ...step!, path: C }, false, true), "precondition: the copy's Attach applied").toBe(true);

		await clear(r);

		const after = (JSON.parse(r.fake.files.get(FILE)!) as { attachments: Record<string, unknown>[] }).attachments;
		expect.soft(after.find((a) => a.id === "gx"), "the opaque group changed").toEqual(future);
		expect.soft(holding(r.groupsOnDisk(), "p0"), "the file holds the stroke in two readable groups, or not in the copy's").toEqual(["g2"]);
	});

	it("the file holds one stroke in two groups of its own, and the copy acted on another stroke: both groups stay as they are", async () => {
		const r = rig({ strokes: [stroke("p0", 5), stroke("t", 80)], groups: [group("g1", ["p0"]), group("g3", ["p0"], "toluene")] });
		await lockedCopyOpen();
		const p = pane(C);
		const { step } = attachGroup(inlineInk.attachments(C), group("g2", ["t"], "benzene", 1));
		expect(p.overlay.applyAttachSettle({ ...step!, path: C }, false, true), "precondition: the copy's Attach applied").toBe(true);

		await clear(r);

		expect.soft(holding(r.groupsOnDisk(), "p0"), "the file's own two groups on a stroke were changed").toEqual(["g1", "g3"]);
		expect.soft(holding(inlineInk.attachments(C), "p0"), "the copy's two groups from the file on a stroke were changed").toEqual(["g1", "g3"]);
		expect.soft(holding(r.groupsOnDisk(), "t"), "the copy's Attach is not in the file").toEqual(["g2"]);
	});

	it("a plain load of a file holding one stroke in two groups: the note's list is the file's", async () => {
		const r = rig({ groups: [group("g1", ["p0"]), group("g3", ["p0"], "toluene")] });
		await inlineInk.ensureLoaded(C);

		expect(holding(inlineInk.attachments(C), "p0"), "a load changed the file's groups").toEqual(["g1", "g3"]);
		expect(ids(r.groupsOnDisk()), "precondition: the file is as written").toEqual(["g1", "g3"]);
	});

	it("after the clear, an undo of the copy's Attach, then a redo: the stroke in one group at most each time, in the copy and the file", async () => {
		const r = rig();
		const { step, p } = await bothAttach(r, group("g1", ["p0"]));
		await clear(r);

		p.overlay.applyAttachSettle({ ...invertAttachStep(step), path: C });
		await r.drain();
		expect.soft(holding(inlineInk.attachments(C), "p0").length, "after the undo the copy holds the stroke in two groups").toBeLessThanOrEqual(1);
		expect.soft(holding(r.groupsOnDisk(), "p0").length, "after the undo the file holds the stroke in two groups").toBeLessThanOrEqual(1);

		p.overlay.applyAttachSettle({ ...step, path: C });
		await r.drain();
		expect.soft(holding(inlineInk.attachments(C), "p0"), "after the redo the copy holds the stroke in two groups, or not in its own").toEqual(["g2"]);
		expect.soft(holding(r.groupsOnDisk(), "p0"), "after the redo the file holds the stroke in two groups, or not in the copy's").toEqual(["g2"]);
	});

	/**
	 * A known limit, before and after the fix (it.fails). The copy's Attach settles a stroke shown where it is stored by no
	 * move, so the stroke is not the copy's (moveStrokes moves nothing for none), and the clear's read takes the file's
	 * stroke, settled by the original: on the copy and in the file it is drawn by the copy's group as far off where it showed
	 * on the copy as the original's settle moved it. The copy's group itself stays as the copy made it.
	 */
	it.fails("the original's Attach settled the stroke, moving it, and saved; the copy attached it to another word through the lasso: the stroke where it showed on the copy, in the copy and the file", async () => {
		const r = rig();
		await lockedCopyOpen();
		// As the original's Attach writes a member it settles (applyAttachSettle): the stroke's stored points moved to where the
		// original showed it, then the list with the group, one save.
		inlineInk.moveStrokes(N, ["p0"], 0, 30);
		await originalSetsGroups(r, [{ ...group("g1", ["p0"]), probe: { id: "p0", x: 5, y: 70 } }]);
		const filePage = () => parsePage(r.fake.files.get(FILE)!, X).data;
		expect({ file: yOf(filePage().strokes, "p0"), copy: yOf(inlineInk.strokes(C), "p0") }, "precondition: the original's settle moved the stroke in the file, and the locked copy holds it where it was").toEqual({ file: 70, copy: 40 });

		const p = attachPane(C);
		expect(await p.attach(["p0"]), "precondition: Attach is offered").toBe(true);
		const made = inlineInk.attachments(C).filter((a): a is AttachmentRecord => "strokeIds" in a);
		expect({ groups: made.length, members: made[0]?.strokeIds }, "precondition: the copy's Attach made one group of the stroke").toEqual({ groups: 1, members: ["p0"] });
		const mine = made[0]!;
		expect(mine.id !== "g1" && mine.target.from !== groupIn(r.groupsOnDisk(), "g1")!.target.from, "precondition: the copy attached the stroke to another word, under an id of its own").toBe(true);
		/** Where the stroke shows by the copy's group over DOC: its stored point moved by that group's follow. */
		const shownBy = (list: readonly AttachmentData[], strokes: readonly InkStroke[]): number | undefined => {
			const g = groupIn(list, mine.id), y = yOf(strokes, "p0");
			return g === undefined || y === undefined ? undefined : y + topAt(DOC, g.target.from) - g.ref.y;
		};
		const shown = shownBy(inlineInk.attachments(C), inlineInk.strokes(C));
		expect(shown, "precondition: the stroke shows on the copy").toBeTypeOf("number");

		await clear(r);

		expect.soft({ copy: shownBy(inlineInk.attachments(C), inlineInk.strokes(C)), file: shownBy(r.groupsOnDisk(), filePage().strokes) }, "the stroke is drawn off where it showed on the copy").toEqual({ copy: shown, file: shown });
		expect.soft({ copy: yOf(inlineInk.strokes(C), "p0"), file: yOf(filePage().strokes, "p0") }, "the stroke's stored place is not the one the copy held").toEqual({ copy: 40, file: 40 });
		expect.soft({ copy: groupIn(inlineInk.attachments(C), mine.id), file: groupIn(r.groupsOnDisk(), mine.id) }, "the copy's group is not as the copy made it").toEqual({ copy: mine, file: mine });
	});

	/** The known limit's plain twin: the same case, its group want alone, so a break of the copy's group here shows. */
	it("the original's Attach settled the stroke, moving it, and saved; the copy attached it to another word through the lasso: the copy's group stays as the copy made it, in the copy and the file", async () => {
		const r = rig();
		await lockedCopyOpen();
		inlineInk.moveStrokes(N, ["p0"], 0, 30);
		await originalSetsGroups(r, [{ ...group("g1", ["p0"]), probe: { id: "p0", x: 5, y: 70 } }]);
		const filePage = () => parsePage(r.fake.files.get(FILE)!, X).data;
		expect({ file: yOf(filePage().strokes, "p0"), copy: yOf(inlineInk.strokes(C), "p0") }, "precondition: the original's settle moved the stroke in the file, and the locked copy holds it where it was").toEqual({ file: 70, copy: 40 });

		const p = attachPane(C);
		expect(await p.attach(["p0"]), "precondition: Attach is offered").toBe(true);
		const made = inlineInk.attachments(C).filter((a): a is AttachmentRecord => "strokeIds" in a);
		expect({ groups: made.length, members: made[0]?.strokeIds }, "precondition: the copy's Attach made one group of the stroke").toEqual({ groups: 1, members: ["p0"] });
		// A copy, not the store's own record: a change made in place to the copy's group must not change the want too.
		const mine = structuredClone(made[0]!);
		expect(mine.id !== "g1" && mine.target.from !== groupIn(r.groupsOnDisk(), "g1")!.target.from, "precondition: the copy attached the stroke to another word, under an id of its own").toBe(true);

		await clear(r);

		expect({ copy: groupIn(inlineInk.attachments(C), mine.id), file: groupIn(r.groupsOnDisk(), mine.id) }, "the copy's group is not as the copy made it").toEqual({ copy: mine, file: mine });
	});
});
