/**
 * A DELETED NOTE THAT COMES BACK OPENS WITH THE INK THAT WAS LIVE WHEN IT WAS DELETED.
 *
 * The note is open here and an empty save is queued; meanwhile another device's
 * ink syncs in as the live file. Deleting the note then recycles that live file
 * only as a trash copy tagged `-external`, and the restore on reopen skips
 * every tagged copy: the note comes back blank here, with no message, while a
 * device on 1.4.22 opening the same disk restores the other device's six
 * strokes. The two devices then disagree about the same note.
 *
 * Assertions state the 1.4.22 outcome: green = the ink comes back, red = blank.
 */
import { describe, expect, it } from "vitest";
import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageData, emptyPage, serializePage } from "../model/PageData";

(globalThis as { window?: unknown }).window = globalThis;

const ID = "5c2e8f14-7a3b-4d6e-9f01-2b4c6d8e0a13";
const FOLDER = "handwriting";
const LIVE = `${FOLDER}/${ID}.json`;

function pageOf(...labels: string[]): PageData {
	const p = emptyPage(ID);
	p.surface = "inline";
	p.strokes = labels.map((l) => ({
		id: l,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
	})) as PageData["strokes"];
	return p;
}

function vault(): FakeAdapter {
	const fake = new FakeAdapter();
	fake.dirs.add(FOLDER);
	// The restore enumerates the trash; the plain fake has no list().
	(fake as unknown as { list: (folder: string) => Promise<{ files: string[]; folders: string[] }> }).list = async (folder) => ({
		files: [...fake.files.keys()].filter((k) => k.startsWith(`${folder}/`) && !k.slice(folder.length + 1).includes("/")),
		folders: [],
	});
	return fake;
}

const store = (fake: FakeAdapter) => new PageStore({ vault: { adapter: fake } }, FOLDER, () => 5000);

describe("a deleted note whose live ink came from another device", () => {
	it("comes back with that ink when the note is restored", async () => {
		const fake = vault();
		fake.externalWrite(LIVE, serializePage(pageOf("here-1")));
		const here = store(fake);
		await here.load(ID);

		// Another device's six strokes sync in as the live file.
		const theirs = serializePage(pageOf("t1", "t2", "t3", "t4", "t5", "t6"));
		fake.externalWrite(LIVE, theirs);
		// This device's empty save is queued when the note is deleted.
		here.schedule(ID, pageOf());
		await here.remove(ID);
		await here.flush();

		expect(fake.files.has(LIVE), "precondition: the live file went with the note").toBe(false);
		expect(
			[...fake.files.values()].includes(theirs),
			"precondition: the other device's ink is still on disk, in the trash"
		).toBe(true);

		// The note is restored from Obsidian's trash and opened again.
		const reopened = await store(fake).load(ID);
		expect(
			reopened?.data.strokes.map((s) => s.id),
			"the restored note opened blank: the other device's ink stayed in the trash"
		).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
		expect(reopened?.problem).toBe("restored from the ink trash");
	});
});

const TRASH = `${FOLDER}/trash`;
const ink = (...labels: string[]) => serializePage(pageOf(...labels));

/** A vault with these trash files, written in this order, and no live file. */
function trashOnly(files: Array<[string, string]>): FakeAdapter {
	const fake = vault();
	fake.dirs.add(TRASH);
	for (const [name, text] of files) fake.externalWrite(`${TRASH}/${name}`, text);
	return fake;
}

describe("which trash copy a returning note takes", () => {
	it("control: an older plain copy is restored in preference to a newer copy from another device, which stays", async () => {
		const fake = trashOnly([
			[`${ID}-1000.json`, ink("mine")],
			[`${ID}-2000-external.json`, ink("theirs")],
		]);
		const reopened = await store(fake).load(ID);
		expect(reopened?.data.strokes.map((s) => s.id), "the plain copy was not restored").toEqual(["mine"]);
		expect(fake.files.get(`${TRASH}/${ID}-2000-external.json`), "the other device's copy left the trash").toBe(ink("theirs"));
	});

	it("control: an interrupted save, a flush carrier, a wiped page and a superseded save are never restored", async () => {
		const tagged: Array<[string, string]> = ["tmp", "flush", "wipe", "superseded"].map((tag, i) => [
			`${ID}-${1000 + i}-${tag}.json`,
			ink(tag),
		]);
		const fake = trashOnly(tagged);
		expect(await store(fake).load(ID), "a tagged copy was restored").toBeNull();
		for (const [name, text] of tagged) expect(fake.files.get(`${TRASH}/${name}`), `${name} left the trash`).toBe(text);
	});

	it("of two copies from another device, the newer one is restored and the older stays", async () => {
		const fake = trashOnly([
			[`${ID}-1000-external.json`, ink("older")],
			[`${ID}-2000-external.json`, ink("newer")],
		]);
		const reopened = await store(fake).load(ID);
		expect(reopened?.data.strokes.map((s) => s.id), "the newer copy from another device was not restored").toEqual(["newer"]);
		expect(fake.files.get(`${TRASH}/${ID}-1000-external.json`), "the older copy left the trash").toBe(ink("older"));
	});

	it("control: a damaged copy from another device is not restored and stays", async () => {
		const cut = ink("theirs").slice(0, 40);
		const fake = trashOnly([[`${ID}-2000-external.json`, cut]]);
		expect(await store(fake).load(ID), "a damaged copy was restored").toBeNull();
		expect(fake.files.get(`${TRASH}/${ID}-2000-external.json`)).toBe(cut);
	});

	it("restoring the copy from another device is announced once, naming the live file", async () => {
		const fake = trashOnly([[`${ID}-2000-external.json`, ink("theirs")]]);
		const s = store(fake);
		const announced: Array<[string, string]> = [];
		s.onInkTrashRestored = (pageId, restoredTo) => announced.push([pageId, restoredTo]);
		await s.load(ID);
		expect(announced, "the restore was not announced once with the live path").toEqual([[ID, LIVE]]);
	});
});
