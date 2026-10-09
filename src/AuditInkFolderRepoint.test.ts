/**
 * Another device turns on "Compatibility with Obsidian Sync", and its
 * data.json, now naming the `handwriting/` ink folder, syncs in. If this device
 * saves any setting before Obsidian reports the change, the save merges the
 * file's ink folder into the settings without pointing the store at it; the
 * change report that follows sees no folder change. Settings then name
 * `handwriting/` while the store keeps writing `.handwriting/`, which does not
 * sync.
 */
import { describe, expect, it } from "vitest";
import HandwritingPlugin from "./main";
import { PageIdIndex } from "./model/PageIdIndex";

type Proto = {
	loadSettings(this: unknown): Promise<void>;
	persistSettings(this: unknown, onHide?: boolean): Promise<void>;
	onExternalSettingsChange(this: unknown): Promise<void>;
};
const proto = HandwritingPlugin.prototype as unknown as Proto;

/** The plugin's own settings methods over a fake data.json and a store that records its folder. */
function plugin(disk: Record<string, unknown>) {
	const g = globalThis as unknown as { document?: unknown; window?: unknown };
	g.document ??= { body: { classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false } } };
	g.window ??= { setTimeout, clearTimeout };
	const p = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	p.gatedCommandDefs = new Map();
	const folder = { current: ".handwriting" };
	p.disk = { ...disk };
	p.loadData = () => Promise.resolve(JSON.parse(JSON.stringify(p.disk)));
	p.saveData = (d: unknown) => {
		p.disk = JSON.parse(JSON.stringify(d));
		return Promise.resolve();
	};
	p.settingsTimer = null;
	p.settingsDirty = false;
	p.settingsWriting = null;
	p.settingsWriteAgain = false;
	p.store = {
		useInkFolder: (f: string) => {
			folder.current = f;
		},
		inkFolder: () => folder.current,
		holdWrites: () => {},
		releaseWrites: () => {},
		flushDispatch: () => {},
	};
	p.pdfStore = { attachHost: () => {} };
	p.pageIds = new PageIdIndex();
	p.app = {
		workspace: { onLayoutReady: () => {}, iterateAllLeaves: () => {} },
		vault: { adapter: { exists: async () => false, list: async () => ({ files: [], folders: [] }) } },
	};
	p.manifest = { version: "1.4.23", dir: ".obsidian/plugins/handwriting" };
	p.applyPaperTo = () => {};
	p.applyBooxMode = () => {};
	return { p, folder };
}

describe("another device's ink folder, taken in by an ordinary settings save", () => {
	it("the store writes to the folder the settings now name", async () => {
		const { p, folder } = plugin({ inkFolder: ".handwriting", toolbarCorner: "top-right" });
		await proto.loadSettings.call(p);
		expect(folder.current, "precondition: the store starts in .handwriting").toBe(".handwriting");

		// The other device's data.json, naming handwriting/, syncs in.
		p.disk = { ...(p.disk as object), inkFolder: "handwriting" };
		// This device saves another setting before the change is reported.
		(p.settings as Record<string, unknown>).toolbarCorner = "top-left";
		await proto.persistSettings.call(p);
		// Then the change report arrives.
		await proto.onExternalSettingsChange.call(p);

		expect((p.settings as Record<string, unknown>).inkFolder, "precondition: the settings name handwriting/").toBe("handwriting");
		expect(folder.current, "the settings name handwriting/ but the store still writes .handwriting/").toBe("handwriting");
	});
});
