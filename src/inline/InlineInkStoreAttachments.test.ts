/**
 * Ink attached to text in the store: the note record holds the session's list over the file's,
 * a real edit writes the page and a target only mapped through typing writes nothing, and the page written carries the
 * session's list. Each cell names the defect that must turn it red.
 */
import { describe, expect, it } from "vitest";
import { InlineInkStore, type InlineInkHost } from "./InlineInkStore";
import { emptyPage } from "../model/PageData";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

const DOC = "One line.\nThe word benzene here.\n";
const PATH = "attach-store.md";
const record = (id: string, y: number): AttachmentRecord => {
	const from = DOC.indexOf("benzene");
	return { v: 1, id, strokeIds: ["s1"], target: targetAt(DOC, from, from + 7, "range"), ref: { x: 0, y }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 1, y: 2 } };
};

function setup() {
	const store = new InlineInkStore();
	const writes: number[] = [];
	Object.defineProperty(store, "persist", { value: () => writes.push(1) });
	const rec = store.record(PATH);
	rec.pageId = "page-1";
	rec.basePage = { ...emptyPage("page-1"), attachments: [record("att-file", 20)] };
	return { store, rec, writes };
}

describe("attached groups in the store", () => {
	it("the file's list until the session changes it, then the session's, the same object each read", () => {
		// Defect: the session list is never read (an attach shows nothing), or a new array per read (every read re-maps).
		const { store, rec } = setup();
		expect(store.attachments(PATH)).toBe(rec.basePage!.attachments);
		const mine = [record("att-1", 40)];
		store.setAttachments(PATH, mine, true);
		expect(store.attachments(PATH)).toBe(mine);
		expect(store.attachments(PATH)).toBe(store.attachments(PATH));
	});

	it("a target mapped through typing writes nothing; a real edit writes the page once", () => {
		// Defect: every keystroke that maps a target writes the sidecar; or Attach never reaches disk.
		const { store, rec, writes } = setup();
		const gen = rec.mutationGeneration;
		store.setAttachments(PATH, [record("att-file", 20)], false);
		expect(writes).toHaveLength(0);
		expect(rec.mutationGeneration).toBe(gen);
		store.setAttachments(PATH, [record("att-file", 60)], true);
		expect(writes).toHaveLength(1);
		expect(rec.mutationGeneration).toBe(gen + 1);
	});

	it("the page written carries the session's list over the file's, and the file's when the session has none", () => {
		// Defect: snapshot spreads the loaded page only, so a session's attach or settle never reaches disk.
		const { store, rec } = setup();
		store.host = {} as InlineInkHost;
		expect(store.snapshot(rec)!.attachments).toEqual([record("att-file", 20)]);
		const mine = [record("att-1", 40)];
		store.setAttachments(PATH, mine, true);
		expect(store.snapshot(rec)!.attachments).toEqual(mine);
	});
});
