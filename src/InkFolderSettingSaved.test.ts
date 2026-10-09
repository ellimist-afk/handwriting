/**
 * Changing the ink folder must not report success for a setting that was never saved.
 *
 * `changeInkFolder` moves the sidecar files, repoints the store, and then asks
 * for the new folder to be saved without waiting. Two ways that save does not
 * happen, both followed by the notice "ink folder is now ...":
 * - the settings file could not be read at launch, so the plugin writes
 *   nothing to it (settingsReadFailed): the next launch is back on the old
 *   folder and the ink sits in the new one;
 * - the write itself fails after the move.
 *
 * Real `changeInkFolder`, `changeFolder`, `migrateInkFolder`, `PageStore` and
 * settings save path on the plugin prototype, over a `FakeAdapter`. Substituted:
 * `Notice`, which records, and `loadData`/`saveData`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signals = vi.hoisted(() => ({ notices: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: string) {
			signals.notices.push(message);
		}
	},
}));

import HandwritingPlugin from "./main";
import { PageStore } from "./persistence/PageStore";
import { FakeAdapter } from "./persistence/FakeAdapter";
import { emptyPage, serializePage } from "./model/PageData";

/** A FakeAdapter that can list a folder, as the vault adapter does. */
class ListingAdapter extends FakeAdapter {
	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = path.endsWith("/") ? path : `${path}/`;
		return { files: [...this.files.keys()].filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/")), folders: [] };
	}
}

const OLD = ".handwriting";
const NEW = "moved-ink";
const SIDECAR = `${OLD}/page-one.json`;

async function device(options: { readFailed: boolean; saveFails: boolean }) {
	const adapter = new ListingAdapter();
	adapter.dirs.add(OLD);
	adapter.externalWrite(SIDECAR, serializePage({ ...emptyPage("page-one"), strokes: [] }));
	const store = new PageStore({ vault: { adapter } } as never);
	const p = Object.create(HandwritingPlugin.prototype) as Record<string, any>;
	p.disk = { inkFolder: OLD };
	p.loadData = () => Promise.resolve(JSON.parse(JSON.stringify(p.disk)));
	p.saveData = (d: unknown) => {
		if (options.saveFails) return Promise.reject(new Error("EIO settings write"));
		p.disk = JSON.parse(JSON.stringify(d));
		return Promise.resolve();
	};
	p.settingsTimer = null;
	p.settingsDirty = false;
	p.settingsWriting = null;
	p.settingsWriteAgain = false;
	p.store = store;
	p.pdfStore = { attachHost: () => {} };
	p.app = { workspace: { onLayoutReady: () => {}, iterateAllLeaves: () => {} }, vault: { adapter } };
	p.manifest = { version: "1.4.22", dir: ".obsidian/plugins/handwriting" };
	p.applyPaperTo = () => {};
	p.applyBooxMode = () => {};
	p.refreshHeaderActions = () => {};
	p.applyStatusBarVisibility = () => {};
	p.applyGatedCommandRegistration = () => {};
	p.gatedCommandDefs = new Map();
	await p.loadSettings();
	p.settingsReadFailed = options.readFailed;
	return { adapter, store, p };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	vi.stubGlobal("document", { body: { classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false } } });
	vi.spyOn(console, "error").mockImplementation(() => {});
	signals.notices.length = 0;
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const successNotice = (): boolean => signals.notices.some((n) => n.includes("ink folder is now"));

describe("changing the ink folder when the new folder cannot be saved", () => {
	it("the settings file could not be read at launch: the folder is not changed and the user is told why", async () => {
		const d = await device({ readFailed: true, saveFails: false });

		const done = d.p.changeInkFolder(NEW);
		await vi.runAllTimersAsync();
		await done;

		expect(await d.adapter.exists(SIDECAR), "the files were moved although the new folder cannot be saved").toBe(true);
		expect(d.p.settings.inkFolder, "the setting changed in memory only").toBe(OLD);
		expect(successNotice(), "the user was told the folder changed").toBe(false);
		expect(signals.notices).toEqual([
			"Handwriting: the ink folder was not changed. The plugin settings could not be read at startup; restart Obsidian and try again.",
		]);
	});

	it("the settings write fails after the move: the user is not told the folder changed", async () => {
		const d = await device({ readFailed: false, saveFails: true });

		const done = d.p.changeInkFolder(NEW);
		await vi.runAllTimersAsync();
		await done;

		expect(await d.adapter.exists(`${NEW}/page-one.json`), "the move did not happen, so this cell proves nothing").toBe(true);
		expect(successNotice(), "the notice said the folder changed with the setting unsaved").toBe(false);
		expect(signals.notices).toEqual([
			`Handwriting: ink moved to ${NEW}, but the setting could not be saved. Change any Handwriting setting to save it, or the ink folder goes back to ${OLD} at the next start.`,
		]);
		expect(d.p.settings.inkFolder, "the setting must stay in memory").toBe(NEW);
		expect(d.p.settingsDirty, "the setting must stay marked unsaved so the next save writes it").toBe(true);
	});

	it("the setting saves: the folder changes and the user is told", async () => {
		const d = await device({ readFailed: false, saveFails: false });

		const done = d.p.changeInkFolder(NEW);
		await vi.runAllTimersAsync();
		await done;

		expect(await d.adapter.exists(`${NEW}/page-one.json`)).toBe(true);
		expect((d.p.disk as { inkFolder?: string }).inkFolder).toBe(NEW);
		expect(successNotice()).toBe(true);
	});
});
