/**
 * CHANGING THE INK FOLDER CARRIES EVERY CUT-OFF INK FILE, WHATEVER ITS FIRST KEY.
 *
 * A folder change moves a broken bare .json only when its name is one this
 * plugin mints or its first bytes are exactly `{"schemaVersion":<n>,"pageId":"`.
 * Ink files that are ours fail both: a page with a user-chosen id
 * (`meeting-notes.json`), a slides deck (`<uuid>.slides.json`, whose name is
 * not a minted id), and a page re-saved by 1.4.21 after 1.4.22 wrote it, which
 * puts `fontRefPx` first. Cut off mid-write, such a file stays in the old
 * folder; when that folder is a custom one it is no longer searched, and the
 * note opens without that ink. 1.4.22 moved both.
 *
 * Assertions state the behaviour 1.4.22 had: green = carried, red = left behind.
 */
import { describe, expect, it } from "vitest";
import { migrateInkFolder, type MigrationAdapter } from "./InkFolder";
import { FakeAdapter } from "./FakeAdapter";

const FROM = "ink";
const TO = "handwriting";
const UUID = "504fdb34-aed8-42a0-8df8-66f7db7a02de";

function rig(files: Record<string, string>) {
	const disk = new FakeAdapter();
	disk.dirs.add(FROM);
	for (const [name, bytes] of Object.entries(files)) disk.externalWrite(`${FROM}/${name}`, bytes);
	const adapter: MigrationAdapter = {
		exists: (p) => disk.exists(p),
		mkdir: async (p) => { disk.dirs.add(p); },
		read: (p) => disk.read(p),
		rename: (a, b) => disk.rename(a, b),
		list: async (folder) => ({ files: [...disk.files.keys()].filter((p) => p.startsWith(folder + "/")), folders: [] }),
	};
	return { disk, adapter };
}

/** A 1.4.21 re-save of a 1.4.22 page, cut off inside a stroke's points. */
const FONT_FIRST =
	'{"fontRefPx":16,"schemaVersion":1,"pageId":"meeting-notes","surface":"inline","strokes":[{"id":"s-1","tool":"pen","color":"#4b7bec","width":2,"createdAt":1,"pts":[1,2,0.5,';
/** A slides deck with a top key this build does not know, cut off inside its strokes. */
const SLIDES = `{"futureTop":1,"schemaVersion":1,"pageId":"${UUID}.slides","surface":"inline","strokes":[{"id":"s-1"`;

describe("a folder change carries cut-off ink files whose first key is not schemaVersion", () => {
	it("control: a cut-off file under a minted name is carried", async () => {
		const bytes = `{"fontRefPx":16,"schemaVersion":1,"pageId":"${UUID}","strokes":[{"id":"s-1"`;
		expect(() => JSON.parse(bytes), "premise: the file is cut off").toThrow();
		const { disk, adapter } = rig({ [`${UUID}.json`]: bytes });
		await migrateInkFolder(adapter, FROM, TO);
		expect(disk.files.get(`${TO}/${UUID}.json`)).toBe(bytes);
	});

	it("a page with its own id, re-saved by 1.4.21 so fontRefPx comes first, is carried", async () => {
		expect(() => JSON.parse(FONT_FIRST), "premise: the file is cut off").toThrow();
		const { disk, adapter } = rig({ "meeting-notes.json": FONT_FIRST });
		await migrateInkFolder(adapter, FROM, TO);
		expect(disk.files.get(`${TO}/meeting-notes.json`), "the cut-off page was left in the old folder").toBe(FONT_FIRST);
		expect(disk.files.has(`${FROM}/meeting-notes.json`)).toBe(false);
	});

	it("a slides deck file whose first key is not schemaVersion is carried", async () => {
		expect(() => JSON.parse(SLIDES), "premise: the file is cut off").toThrow();
		const { disk, adapter } = rig({ [`${UUID}.slides.json`]: SLIDES });
		await migrateInkFolder(adapter, FROM, TO);
		expect(disk.files.get(`${TO}/${UUID}.slides.json`), "the cut-off slides deck was left in the old folder").toBe(SLIDES);
		expect(disk.files.has(`${FROM}/${UUID}.slides.json`)).toBe(false);
	});

	it("a slides deck file cut off before either page key is carried by its name", async () => {
		const bytes = '{"futureTop":1,"sche';
		expect(() => JSON.parse(bytes), "premise: the file is cut off").toThrow();
		const { disk, adapter } = rig({ [`${UUID}.slides.json`]: bytes });
		await migrateInkFolder(adapter, FROM, TO);
		expect(disk.files.get(`${TO}/${UUID}.slides.json`), "the cut-off slides deck was left in the old folder").toBe(bytes);
	});

	it("control: broken text holding both page keys but not opening with a brace stays", async () => {
		const bytes = 'x {"schemaVersion":1,"pageId":"';
		const { disk, adapter } = rig({ "notes.json": bytes });
		await migrateInkFolder(adapter, FROM, TO);
		expect(disk.files.get(`${FROM}/notes.json`), "a file that is not a page of ours was moved").toBe(bytes);
		expect(disk.files.has(`${TO}/notes.json`)).toBe(false);
	});

	it("control: a slides-looking name that is not a minted id, cut off with no page keys, stays", async () => {
		const bytes = '{"futureTop":1,"sche';
		const { disk, adapter } = rig({ "notes.slides.json": bytes });
		await migrateInkFolder(adapter, FROM, TO);
		expect(disk.files.get(`${FROM}/notes.slides.json`), "a file that is not a page of ours was moved").toBe(bytes);
		expect(disk.files.has(`${TO}/notes.slides.json`)).toBe(false);
	});

	it("both together: every file ends up in the new folder", async () => {
		const { disk, adapter } = rig({ "meeting-notes.json": FONT_FIRST, [`${UUID}.slides.json`]: SLIDES });
		const r = await migrateInkFolder(adapter, FROM, TO);
		expect([...disk.files.keys()].filter((k) => !k.startsWith(`${TO}/`)), "files left in the old folder").toEqual([]);
		expect(r.moved, "moved count").toBe(2);
	});
});
