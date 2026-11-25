/**
 * A note and its copy carry the same page id, and only the copy is duplicate-locked. The shared file holds strokes A, B
 * and D and one attached group, g0 (A and D). While the copy is locked the original attaches B as a new group, g1, and
 * saves it; the copy changes g0 to hold A alone. The original is deleted, and the delete's clear reads the shared file
 * again before saving the copy's own changes over it.
 *
 * Whichever read lands after the clear, the file's newer group stays: the group the original attached is in the copy and
 * in the file, beside the copy's version of the group it changed. The clear's own read lands; or the clear's read throws
 * and a later read heals it: the note opened again, the sync poll, or a third read after a second one threw. After a heal
 * the file is asked first, whatever the copy's list shows.
 *
 * Real InlineInkStore (the plugin's), real PageStore over FakeAdapter, the real delete handler on a plugin built without
 * its constructor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import HandwritingPlugin from "../main";
import { inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";
import { PageIdIndex } from "../model/PageIdIndex";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkStroke } from "../ink/Stroke";

const N = "Original.md";
const C = "Original 1.md";
const X = "shared-id";
const FILE = `.handwriting/${X}.json`;

/** A straight stroke, a point every 2 px. */
function line(id: string, x0: number, y0: number, x1: number, y1: number): InkStroke {
	const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / 2;
	const points: InkStroke["points"] = [];
	for (let i = 0; i <= n; i++) points.push({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n, pressure: 0.5, t: i });
	const x = Math.min(x0, x1), y = Math.min(y0, y1);
	return { id, tool: "pen", color: "#000000", width: 2, points, bbox: { x, y, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) }, createdAt: 0 };
}
const A = (): InkStroke => line("A", 0, 100, 200, 100);
const B = (): InkStroke => line("B", 150, 40, 150, 160);
const D = (): InkStroke => line("D", 0, 400, 100, 400);

const DOC = "One line.\nThe word benzene here.\n";

function group(id: string, strokeIds: string[]): AttachmentRecord {
	const from = DOC.indexOf("benzene");
	return {
		v: 1, id, strokeIds, target: targetAt(DOC, from, from + 7, "range"), ref: { x: 0, y: 20 },
		layout: { width: 600, font: 16 }, probe: { id: strokeIds[0]!, x: 0, y: 100 },
	};
}
/** Each group as "id:member,member", in order. */
const groupNames = (list: readonly AttachmentData[]): string[] =>
	list.map((a) => `${a.id}:${(a as AttachmentRecord).strokeIds.join(",")}`);

/**
 * Two notes on one id, the shared file holding A, B, D and g0 (A, D) unless given. `throwNext` makes the next read of
 * the shared file throw in the adapter, as a busy disk or a sync client mid-write does, so the store answers that the
 * file is not readable yet. `holdNext` keeps the next read of it out until the release it returns. `sent` holds the
 * groups of every page handed to a save, in order; `notices` every notice.
 */
function rig(opts: { strokes?: InkStroke[]; groups?: AttachmentData[] } = {}) {
	const fake = new FakeAdapter();
	let throwing = false;
	let hold: Promise<void> | null = null;
	let heldNow = false;
	const read = fake.read.bind(fake);
	fake.read = async (path: string): Promise<string> => {
		if (throwing && path === FILE) {
			throwing = false;
			throw new Error("EBUSY: the ink file is being written");
		}
		if (hold && path === FILE) {
			const wait = hold;
			hold = null;
			heldNow = true;
			await wait;
			heldNow = false;
		}
		return read(path);
	};
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const shared = emptyPage(X);
	shared.surface = "inline";
	shared.strokes = opts.strokes ?? [A(), B(), D()];
	shared.attachments = opts.groups ?? [group("g0", ["A", "D"])];
	fake.files.set(FILE, serializePage(shared));
	const sent: string[][] = [];
	const notices: string[] = [];
	const files = new Map<string, TFile>();
	for (const path of [N, C]) files.set(path, Object.assign(new TFile(), { path, extension: "md", basename: path.slice(0, -3) }));
	const listed = new Set([N, C]);
	const cache = (path: string) => (files.has(path) ? { frontmatter: { "handwriting-page-id": X }, sections: [{ type: "yaml" }] } : null);
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
			sent.push(groupNames(page.attachments ?? []));
			store.schedule(pageId, page);
		},
		scheduleSidecarNow: (pageId, page) => {
			sent.push(groupNames(page.attachments ?? []));
			return store.saveNow(pageId, page);
		},
		// As the plugin's host answers: whether this page's own write landed.
		sidecarLanded: (page) => store.hasLanded(page),
		// The sync poll's adoption: a record held after a thrown read never reaches these, it is read again through the heal.
		prepareExternalAdoption: async () => ({ kind: "unavailable" }) as never,
		acceptExternalAdoption: () => undefined,
		notify: (text: string) => {
			notices.push(text);
		},
	};
	inlineInk.attachHost(host);
	const filePage = () => {
		const t = fake.files.get(FILE);
		return t === undefined ? null : parsePage(t, X).data;
	};
	const onDisk = (): string[] => (filePage()?.strokes ?? []).map((s) => s.id);
	const groupsOnDisk = (): string[] => groupNames(filePage()?.attachments ?? []);
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
	const holdNext = (): (() => void) => {
		let release = (): void => undefined;
		hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		return () => release();
	};
	const held = (): boolean => heldNow;
	const removeFile = (): void => {
		fake.files.delete(FILE);
	};
	return { onDisk, groupsOnDisk, deleteOriginal, throwNext, holdNext, held, removeFile, sent, notices, drain };
}

/**
 * The copy locked alone, as a failed repair leaves it; both notes open on the shared page. The original attaches B as g1
 * and saves; the copy changes g0 to hold A alone.
 */
async function bothChangeGroups(r: ReturnType<typeof rig>): Promise<void> {
	inlineInk.markDuplicateLocked(C, N);
	await inlineInk.ensureLoaded(C);
	await inlineInk.ensureLoaded(N);
	expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
	inlineInk.setAttachments(N, [group("g0", ["A", "D"]), group("g1", ["B"])], true);
	await r.drain();
	expect(r.groupsOnDisk(), "precondition: the original's new group reached the file").toEqual(["g0:A,D", "g1:B"]);
	inlineInk.setAttachments(C, [group("g0", ["A"])], true);
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
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("a group the original attached while the copy was locked stays after the clear, whichever read lands", () => {
	it("the clear's own read lands: the original's new group stays beside the copy's version of g0, in the copy and in the file", async () => {
		const r = rig();
		await bothChangeGroups(r);

		await clear(r);

		expect(groupNames(inlineInk.attachments(C)), "the copy lost the original's new group, or its own g0").toEqual(["g0:A", "g1:B"]);
		expect(r.groupsOnDisk(), "the file lost the original's new group, or the copy's g0").toEqual(["g0:A", "g1:B"]);
		expect(r.onDisk(), "the file lost a stroke").toEqual(["A", "B", "D"]);
	});

	it("the clear's read throws and a later read heals: the original's new group stays beside the copy's version of g0, in the copy and in the file", async () => {
		const r = rig();
		await bothChangeGroups(r);
		r.throwNext();
		await clear(r);
		expect(inlineInk.isDamagedLocked(C), "precondition: the clear's read threw and holds the copy").toBe(true);
		expect(r.groupsOnDisk(), "precondition: nothing was written while the read could not land").toEqual(["g0:A,D", "g1:B"]);

		await inlineInk.ensureLoaded(C);
		await r.drain();

		expect(inlineInk.isDamagedLocked(C), "precondition: the read healed").toBe(false);
		healed(r);
	});

	it("the clear's read throws and the sync poll's read heals: the same, in the copy and in the file", async () => {
		const r = rig();
		await bothChangeGroups(r);
		r.throwNext();
		await clear(r);
		expect(inlineInk.isDamagedLocked(C), "precondition: the clear's read threw and holds the copy").toBe(true);

		const adopted = await inlineInk.adoptExternal(C, () => true);
		await r.drain();

		expect(adopted.outcome, "precondition: the poll's read healed the copy").toBe("adopted");
		healed(r);
	});

	it("the clear's read throws, a second read throws too, and the third heals: the same, in the copy and in the file", async () => {
		const r = rig();
		await bothChangeGroups(r);
		r.throwNext();
		await clear(r);
		r.throwNext();
		await inlineInk.ensureLoaded(C);
		await r.drain();
		expect(inlineInk.isDamagedLocked(C), "precondition: the second read threw too").toBe(true);
		expect(r.groupsOnDisk(), "precondition: nothing was written while no read could land").toEqual(["g0:A,D", "g1:B"]);

		await inlineInk.ensureLoaded(C);
		await r.drain();

		expect(inlineInk.isDamagedLocked(C), "precondition: the third read healed").toBe(false);
		healed(r);
	});
});

/** After the heal: the file first, whatever the copy shows, then the copy. */
function healed(r: ReturnType<typeof rig>): void {
	expect.soft(r.groupsOnDisk(), "the heal's save dropped the original's new group from the file, or the copy's g0").toEqual(["g0:A", "g1:B"]);
	expect.soft(r.onDisk(), "the file lost a stroke").toEqual(["A", "B", "D"]);
	expect(groupNames(inlineInk.attachments(C)), "the heal dropped the original's new group from the copy, or the copy's g0").toEqual(["g0:A", "g1:B"]);
}

describe("the read that heals a clear's thrown read merges the groups before anything is saved, and only then", () => {
	it("a stroke drawn on the copy while the heal's read is out: every save after it holds the original's new group, and so does the copy", async () => {
		const r = rig();
		await bothChangeGroups(r);
		r.throwNext();
		await clear(r);
		expect(inlineInk.isDamagedLocked(C), "precondition: the clear's read threw and holds the copy").toBe(true);
		const release = r.holdNext();
		const healing = inlineInk.ensureLoaded(C);
		await vi.advanceTimersByTimeAsync(0);
		expect(r.held(), "precondition: the heal's read is out").toBe(true);
		const from = r.sent.length;
		inlineInk.commit(C, line("E", 0, 300, 100, 300));

		release();
		await healing;
		await r.drain();

		expect(inlineInk.isDamagedLocked(C), "precondition: the read healed").toBe(false);
		const after = r.sent.slice(from);
		expect(after.length, "precondition: the copy saved after the heal").toBeGreaterThan(0);
		for (const groups of after) expect.soft(groups, "a save went out before the heal's merge, without the original's new group").toEqual(["g0:A", "g1:B"]);
		expect.soft(r.groupsOnDisk(), "the file lost the original's new group, or the copy's g0").toEqual(["g0:A", "g1:B"]);
		expect.soft(r.onDisk(), "the file lost a stroke, or the one drawn while the read was out").toEqual(["A", "B", "D", "E"]);
		expect(groupNames(inlineInk.attachments(C)), "the copy lost the original's new group, or its own g0").toEqual(["g0:A", "g1:B"]);
	});

	it("a stroke of a group the file changed, erased by the original while the copy was locked, is not drawn again by the heal", async () => {
		const E = line("E", 0, 300, 100, 300);
		const r = rig({ strokes: [A(), B(), D(), E], groups: [group("g0", ["A", "D"]), group("g2", ["B", "E"])] });
		inlineInk.markDuplicateLocked(C, N);
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		inlineInk.takeLive(N, ["E"]);
		inlineInk.setAttachments(N, [group("g0", ["A", "D"]), group("g2", ["B"])], true);
		inlineInk.save(N);
		await r.drain();
		expect(r.onDisk(), "precondition: the original erased E").toEqual(["A", "B", "D"]);
		expect(r.groupsOnDisk(), "precondition: the original's g2 lost E").toEqual(["g0:A,D", "g2:B"]);
		inlineInk.setAttachments(C, inlineInk.attachments(C).map((g) => (g.id === "g0" ? group("g0", ["A"]) : g)), true);
		r.throwNext();
		await clear(r);
		expect(inlineInk.isDamagedLocked(C), "precondition: the clear's read threw and holds the copy").toBe(true);

		await inlineInk.ensureLoaded(C);
		await r.drain();

		expect(inlineInk.isDamagedLocked(C), "precondition: the read healed").toBe(false);
		expect.soft(r.onDisk(), "the heal wrote back E, which the original erased").toEqual(["A", "B", "D"]);
		expect.soft(r.groupsOnDisk(), "the file lost the original's g2, or the copy's g0").toEqual(["g0:A", "g2:B"]);
		expect(inlineInk.strokes(C).map((s) => s.id), "the copy draws E again, which the original erased").toEqual(["A", "B", "D"]);
		expect(groupNames(inlineInk.attachments(C)), "the copy lost the original's g2, or its own g0").toEqual(["g0:A", "g2:B"]);
	});

	it("the file is gone when the heal reads it: the copy's ink and groups start it again, and the user is told once", async () => {
		const r = rig();
		await bothChangeGroups(r);
		r.throwNext();
		await clear(r);
		expect(inlineInk.isDamagedLocked(C), "precondition: the clear's read threw and holds the copy").toBe(true);
		r.removeFile();
		const told = r.notices.length;

		await inlineInk.ensureLoaded(C);
		await r.drain();

		expect(inlineInk.isDamagedLocked(C), "precondition: the read found no file and lifted the hold").toBe(false);
		expect.soft(r.groupsOnDisk(), "the copy's groups did not start the file again").toEqual(["g0:A"]);
		expect.soft(r.onDisk(), "the copy's ink did not start the file again").toEqual(["A", "B", "D"]);
		expect(r.notices.slice(told).filter((n) => n.includes("is gone")), "the file being gone was not told once").toHaveLength(1);
	});
});

/**
 * A locked copy whose read threw when it opened holds no page and no group. The original adds g1 and saves; the copy sets
 * g0 to A alone. Whether the clear lands before the heal, while the heal reads, or after it, the file's groups stand at the
 * heal and the copy's g0 joins them: g0 as the copy left it and the original's g1, in the file and the copy, no stroke lost.
 */
describe("a copy unreadable when it opened, healed around its clear, keeps the file's groups beside its own", () => {
	/** The copy, locked, reads damaged at open; the original adds g1 and saves; the copy sets g0 to A alone. */
	async function damagedCopyAndNewGroup(r: ReturnType<typeof rig>): Promise<void> {
		inlineInk.markDuplicateLocked(C, N);
		r.throwNext();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		expect(inlineInk.isDamagedLocked(C), "precondition: the copy's read at open threw").toBe(true);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		inlineInk.setAttachments(N, [group("g0", ["A", "D"]), group("g1", ["B"])], true);
		await r.drain();
		expect(r.groupsOnDisk(), "precondition: the original's new group reached the file").toEqual(["g0:A,D", "g1:B"]);
		inlineInk.setAttachments(C, [group("g0", ["A"])], true);
	}

	function healedWithBoth(r: ReturnType<typeof rig>): void {
		expect(inlineInk.isDuplicateLocked(C), "precondition: the clear lifted the lock").toBe(false);
		expect(inlineInk.isDamagedLocked(C), "precondition: the heal healed").toBe(false);
		expect.soft(r.groupsOnDisk(), "the file lost the original's new group, or the copy's g0").toEqual(["g0:A", "g1:B"]);
		expect.soft(r.onDisk(), "the file lost a stroke").toEqual(["A", "B", "D"]);
		expect.soft(groupNames(inlineInk.attachments(C)), "the copy lost the original's new group, or its own g0").toEqual(["g0:A", "g1:B"]);
	}

	it("the clear lands while the heal reads the file", async () => {
		const r = rig();
		await damagedCopyAndNewGroup(r);
		const release = r.holdNext();
		const healing = inlineInk.ensureLoaded(C);
		await vi.advanceTimersByTimeAsync(0);
		expect(r.held(), "precondition: the heal's read is out").toBe(true);
		await r.deleteOriginal();
		release();
		await healing;
		await r.drain();
		healedWithBoth(r);
	});

	it("the clear lands before the heal", async () => {
		const r = rig();
		await damagedCopyAndNewGroup(r);
		await r.deleteOriginal();
		await r.drain();
		await inlineInk.ensureLoaded(C);
		await r.drain();
		healedWithBoth(r);
	});

	it("the clear lands after the heal", async () => {
		const r = rig();
		await damagedCopyAndNewGroup(r);
		await inlineInk.ensureLoaded(C);
		await r.drain();
		await r.deleteOriginal();
		await r.drain();
		healedWithBoth(r);
	});
});
