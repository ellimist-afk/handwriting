/**
 * Two notes share an id with no owner on record, so the copy is locked and its ink is held in memory. Ink
 * drawn on the copy and attached to a word there keeps its group when the copy's id line is fixed: handleDeclaimed
 * carries the copy's own strokes to a fresh record under the note's new id, and with them each attached group pruned to
 * those strokes. A group of the shared file's ink only is the other note's and stays behind. The carried groups survive
 * the read of the new id's file, beside any group that file holds, and are written there. Store level: the text the group
 * follows is not typed here; a kept group with its target and shown move is what the open note follows it by.
 */
import { describe, expect, it } from "vitest";
import { InlineInkStore, type InlineInkHost } from "./InlineInkStore";
import { targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";
import type { InkStroke } from "../ink/Stroke";
import { emptyPage, type PageData } from "../model/PageData";

const COPY = "copy.md";
const SHARED = "shared-id";
const NEW = "new-id";
const DOC = "One line.\nThe word benzene here.\n";

function stroke(id: string, y: number): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2, createdAt: 0,
		points: [{ x: 10, y, pressure: 0.5, t: 0 }, { x: 40, y: y + 6, pressure: 0.5, t: 8 }],
		bbox: { x: 10, y, width: 30, height: 6 },
	} as InkStroke;
}

function group(id: string, strokeIds: string[], shown?: { dx: number; dy: number }): AttachmentRecord {
	const from = DOC.indexOf("benzene");
	return {
		v: 1, id, strokeIds, target: targetAt(DOC, from, from + 7, "range"), ref: { x: 0, y: 20 },
		layout: { width: 600, font: 16 }, probe: { id: strokeIds[0]!, x: 10, y: 20 }, ...(shown ? { shown } : {}),
	};
}

function page(id: string, strokes: InkStroke[], attachments: AttachmentData[] = []): PageData {
	const p = emptyPage(id);
	(p as PageData & { surface: string }).surface = "inline";
	p.strokes = strokes;
	if (attachments.length > 0) p.attachments = attachments;
	return p;
}

async function settle(): Promise<void> {
	for (let i = 0; i < 200; i++) await Promise.resolve();
}

/** A copy locked on the shared id, holding the file's stroke and group, plus its own stroke attached at shown {0, 20}. */
async function lockedCopyWithOwnGroup(newIdFile: PageData | null) {
	const ids = new Map([[COPY, SHARED]]);
	const disk = new Map<string, PageData>([[SHARED, page(SHARED, [stroke("theirs", 20)], [group("g-theirs", ["theirs"])])]]);
	if (newIdFile) disk.set(NEW, newIdFile);
	const writes: Array<{ pageId: string; page: PageData }> = [];
	let hold: Promise<void> | null = null;
	const host = {
		readPageId: (p: string) => ids.get(p) ?? null,
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: async (id: string) => {
			if (id === NEW && hold) await hold;
			const d = disk.get(id);
			return d ? { data: structuredClone(d), recovered: false } : null;
		},
		scheduleSidecar: (pageId: string, p: PageData) => void writes.push({ pageId, page: structuredClone(p) }),
		scheduleSidecarNow: async (pageId: string, p: PageData) => void writes.push({ pageId, page: structuredClone(p) }),
		notify: () => undefined,
	} as unknown as InlineInkHost;
	const store = new InlineInkStore();
	store.attachHost(host);
	await store.ensureLoaded(COPY);
	store.markDuplicateLocked(COPY, "original.md");
	store.commit(COPY, stroke("own", 60));
	store.setAttachments(COPY, [...store.attachments(COPY), group("g-own", ["own"], { dx: 0, dy: 20 })], true);
	await settle();
	expect(writes.length, "precondition: the lock refused every write").toBe(0);
	expect(store.attachments(COPY).map((a) => a.id), "precondition: the copy holds the file's group and its own").toEqual(["g-theirs", "g-own"]);
	let release = (): void => undefined;
	hold = new Promise<void>((r) => (release = r));
	// The user fixes the copy's id line; the identity check declaims it.
	ids.set(COPY, NEW);
	store.handleDeclaimed(COPY);
	return { store, writes, release };
}

const groupIds = (list: readonly AttachmentData[]): string[] => list.map((a) => a.id).sort();
const shownOf = (list: readonly AttachmentData[], id: string) => (list.find((a) => a.id === id) as AttachmentRecord | undefined)?.shown;

describe("a locked copy's attached ink keeps its group when the id line is fixed", () => {
	it("the own group is carried, pruned to the own stroke, through the new id's read and into its file", async () => {
		// Defect: carryOwnInk carries the strokes only, so the group and its shown move are gone: the ink stops following
		// its word and jumps back by the move, and is saved that way under the new id.
		const { store, writes, release } = await lockedCopyWithOwnGroup(null);
		expect(groupIds(store.attachments(COPY)), "the group left the copy while the new id is read").toEqual(["g-own"]);
		release();
		await settle();
		expect(store.strokes(COPY).map((s) => s.id), "precondition: the own stroke was carried").toEqual(["own"]);
		expect(groupIds(store.attachments(COPY)), "the carried group did not survive the new id's read").toEqual(["g-own"]);
		expect(shownOf(store.attachments(COPY), "g-own"), "the group's shown move was lost").toEqual({ dx: 0, dy: 20 });
		expect(store.strokes(COPY)[0]!.points[0], "the stroke's points moved: the ink is not at its shown place").toEqual({ x: 10, y: 60, pressure: 0.5, t: 0 });
		const last = [...writes].reverse().find((w) => w.pageId === NEW);
		expect(last, "precondition: the carried ink was written under the new id").toBeDefined();
		expect(groupIds(last!.page.attachments ?? []), "the new id's file lacks the carried group").toEqual(["g-own"]);
	});

	it("a group the new id's file already holds stays beside the carried one", async () => {
		// Defect: the carried list hides the file's own groups, or the file's list drops the carried one.
		const { store, writes, release } = await lockedCopyWithOwnGroup(page(NEW, [stroke("there", 100)], [group("g-there", ["there"])]));
		release();
		await settle();
		expect(store.strokes(COPY).map((s) => s.id).sort(), "precondition: the file's stroke and the carried one").toEqual(["own", "there"]);
		expect(groupIds(store.attachments(COPY)), "the file's group or the carried one is missing after the read").toEqual(["g-own", "g-there"]);
		const last = [...writes].reverse().find((w) => w.pageId === NEW);
		expect(groupIds(last?.page.attachments ?? []), "the new id's file lost a group").toEqual(["g-own", "g-there"]);
	});
});
