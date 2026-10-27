/**
 * An empty settings file is no settings, not a settings file that could not
 * be read.
 *
 * `loadData` parses data.json, and an empty file does not parse: it comes back
 * the same as a locked or truncated one. loadSettings treated both as a failed
 * read, ran on defaults and wrote nothing, which is right for a file that still
 * holds settings it could not read. An empty file holds none, and it stayed
 * empty for good: every change made in Settings was lost at the next launch,
 * and the "could not read its settings file" notice showed at every start.
 *
 * Text that is empty or only whitespace now loads as an empty settings object,
 * which saves normally. Any other text that does not parse is still a failed
 * read, and nothing is written over it.
 *
 * An empty file has lost the ink folder choice as a missing one has. The plugin
 * takes the folder the vault already keeps its ink in, as it does for a missing
 * or unreadable file, and saves that choice; on the default folder a vault that
 * keeps its ink in handwriting/ would read no ink and start a second copy of
 * every page in .handwriting/.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => ({ messages: [] as unknown[] }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			constructor(message: unknown) {
				notices.messages.push(message);
			}
		},
	};
});

import HandwritingPlugin from "./main";
import { PageIdIndex } from "./model/PageIdIndex";

type Rec = Record<string, unknown>;
type Proto = {
	loadSettings(this: unknown): Promise<void>;
	persistSettings(this: unknown, onHide?: boolean): Promise<void>;
};
const proto = HandwritingPlugin.prototype as unknown as Proto;

const SETTINGS_FILE = ".obsidian/plugins/handwriting/data.json";
const readFailedNotices = (): unknown[] =>
	notices.messages.filter((m) => typeof m === "string" && m.includes("could not read its settings file"));

/**
 * The plugin's own settings methods over a data.json holding `text`. `loadData`
 * answers as Obsidian's does: the parsed object, or undefined when the text
 * does not parse.
 */
function plugin(text: string, folders: Record<string, string[]> = {}) {
	const g = globalThis as unknown as { document?: unknown; window?: unknown };
	g.document ??= { body: { classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false } } };
	g.window ??= { setTimeout, clearTimeout };
	const p = Object.create(HandwritingPlugin.prototype) as Rec;
	const file = { text, writes: [] as Rec[], storeFolder: ".handwriting" };
	p.gatedCommandDefs = new Map();
	p.loadData = () => {
		try {
			return Promise.resolve(JSON.parse(file.text) as unknown);
		} catch {
			return Promise.resolve(undefined);
		}
	};
	p.saveData = (d: unknown) => {
		const copy = JSON.parse(JSON.stringify(d)) as Rec;
		file.writes.push(copy);
		file.text = JSON.stringify(copy);
		return Promise.resolve();
	};
	p.settingsTimer = null;
	p.settingsDirty = false;
	p.settingsWriting = null;
	p.settingsWriteAgain = false;
	p.store = {
		useInkFolder: (f: string) => {
			file.storeFolder = f;
		},
		inkFolder: () => file.storeFolder,
		holdWrites: () => {},
		releaseWrites: () => {},
		flushDispatch: () => {},
	};
	p.pdfStore = { attachHost: () => {} };
	p.pageIds = new PageIdIndex();
	p.app = {
		workspace: { onLayoutReady: () => {}, iterateAllLeaves: () => {} },
		vault: {
			adapter: {
				exists: async (path: string) => path === SETTINGS_FILE || path in folders,
				list: async (path: string) => ({ files: folders[path] ?? [], folders: [] }),
				read: async (path: string) => {
					if (path !== SETTINGS_FILE) throw new Error(`no file ${path}`);
					return file.text;
				},
			},
		},
	};
	p.manifest = { version: "1.4.23", dir: ".obsidian/plugins/handwriting" };
	p.applyPaperTo = () => {};
	p.applyBooxMode = () => {};
	return { p, file };
}

beforeEach(() => {
	notices.messages.length = 0;
});

describe("an empty settings file", () => {
	it.each([
		["empty", ""],
		["whitespace only", " \r\n\t\n"],
	])("%s: loads as no settings, says nothing, and a change in Settings is written", async (_name, text) => {
		const { p, file } = plugin(text);
		await proto.loadSettings.call(p);
		// Soft, so a red run also says whether the change was written.
		expect.soft(readFailedNotices(), "the could-not-read notice showed for an empty file").toHaveLength(0);
		expect.soft(p.freshInstall, "an empty file is not a first install").toBe(false);

		(p.settings as Rec).toolbarCorner = "top-left";
		await proto.persistSettings.call(p);
		expect(file.writes, "the change in Settings was not written").toHaveLength(1);
		expect(file.writes[0]?.toolbarCorner).toBe("top-left");
	});
});

describe("an empty settings file in a vault that keeps its ink in handwriting/", () => {
	it("takes that folder, points the store at it, and saves the choice", async () => {
		const { p, file } = plugin("", { handwriting: ["handwriting/page-1.json"] });
		await proto.loadSettings.call(p);
		expect.soft((p.settings as Rec).inkFolder, "the settings did not take the folder the ink is in").toBe("handwriting");
		expect.soft(file.storeFolder, "the store does not read the folder the ink is in").toBe("handwriting");

		await proto.persistSettings.call(p);
		expect(file.writes.at(-1)?.inkFolder, "the saved settings do not name the folder the ink is in").toBe("handwriting");
	});
});

describe("a settings file whose text does not parse", () => {
	it("is still a failed read: the notice shows and nothing is written over it", async () => {
		const broken = '{"toolbarCorner": "top-';
		const { p, file } = plugin(broken);
		await proto.loadSettings.call(p);
		expect.soft(readFailedNotices(), "the could-not-read notice did not show").toHaveLength(1);

		(p.settings as Rec).toolbarCorner = "top-left";
		await proto.persistSettings.call(p);
		expect(file.writes, "a write went over a settings file that could not be read").toHaveLength(0);
		expect(file.text).toBe(broken);
	});
});
