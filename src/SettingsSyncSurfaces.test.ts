/**
 * A SETTING THAT SYNCS IN FROM ANOTHER DEVICE REFRESHES THE SCREENS IT DRIVES.
 *
 * Flipping Infinite Canvas, the pen tools mode, the status bar row or the
 * colour and size commands row in the settings tab applies the value and then
 * refreshes what shows it: the header icon and the zoom controls, the pen
 * tools, the status bar, the command palette. When the same change arrives
 * from another device (data.json syncs in and onExternalSettingsChange takes
 * it) the value is applied and none of that is refreshed, so the menu says
 * one thing and the header icon, the toolbar or the status bar another until
 * a note is opened or the layout changes. A save that reads the other
 * device's file first takes the same values and has the same gap.
 *
 * Drives the real onExternalSettingsChange and persistSettings off
 * HandwritingPlugin.prototype over a fake data.json, with the five refreshes
 * spied.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./inline/InkOverlay", async (importOriginal) => {
	const real = await importOriginal<typeof import("./inline/InkOverlay")>();
	return { ...real, refreshPenToolsAll: vi.fn() };
});
vi.mock("./inline/MobileTools", async (importOriginal) => {
	const real = await importOriginal<typeof import("./inline/MobileTools")>();
	return { ...real, refreshNoteZoomControlsAll: vi.fn() };
});

import HandwritingPlugin from "./main";
import { PageIdIndex } from "./model/PageIdIndex";
import { refreshPenToolsAll } from "./inline/InkOverlay";
import { refreshNoteZoomControlsAll } from "./inline/MobileTools";

type Proto = {
	loadSettings(this: unknown): Promise<void>;
	onExternalSettingsChange(this: unknown): Promise<void>;
	persistSettings(this: unknown, onHide?: boolean): Promise<void>;
};
const proto = HandwritingPlugin.prototype as unknown as Proto;

type Counts = { header: number; zoom: number; penTools: number; statusBar: number; commands: number };

function plugin(disk: Record<string, unknown>): Record<string, unknown> {
	const g = globalThis as unknown as { document?: unknown; window?: unknown };
	g.document ??= { body: { classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false } } };
	g.window ??= {
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
		clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
	};
	const p = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	p.disk = { ...disk };
	p.loadData = (): Promise<unknown> => Promise.resolve(JSON.parse(JSON.stringify(p.disk)));
	p.saveData = (data: Record<string, unknown>): Promise<void> => {
		p.disk = JSON.parse(JSON.stringify(data));
		return Promise.resolve();
	};
	p.settingsTimer = null;
	p.settingsDirty = false;
	p.settingsWriting = null;
	p.settingsWriteAgain = false;
	p.store = { useInkFolder: () => {}, holdWrites: () => {}, releaseWrites: () => {}, flushDispatch: () => {} };
	p.pdfStore = { attachHost: () => {} };
	p.pageIds = new PageIdIndex();
	p.app = {
		workspace: { onLayoutReady: () => {}, iterateAllLeaves: () => {} },
		vault: { adapter: { exists: async () => false, list: async () => ({ files: [], folders: [] }) } },
	};
	p.manifest = { version: "1.4.22", dir: ".obsidian/plugins/handwriting" };
	p.applyPaperTo = (): void => {};
	p.applyBooxMode = (): void => {};
	p.refreshHeaderActions = vi.fn();
	p.applyStatusBarVisibility = vi.fn();
	p.applyGatedCommandRegistration = vi.fn();
	return p;
}

function counts(h: Record<string, unknown>): Counts {
	return {
		header: vi.mocked(h.refreshHeaderActions as () => void).mock.calls.length,
		zoom: vi.mocked(refreshNoteZoomControlsAll).mock.calls.length,
		penTools: vi.mocked(refreshPenToolsAll).mock.calls.length,
		statusBar: vi.mocked(h.applyStatusBarVisibility as () => void).mock.calls.length,
		commands: vi.mocked(h.applyGatedCommandRegistration as () => void).mock.calls.length,
	};
}

/** Load with `key` at `from`, clear the spies, sync `to` in from disk through the change report. */
async function sync(key: string, from: unknown, to: unknown): Promise<{ h: Record<string, unknown>; after: Counts }> {
	const h = plugin({ [key]: from, toolbarCorner: "top-right" });
	await proto.loadSettings.call(h);
	vi.mocked(h.refreshHeaderActions as () => void).mockClear();
	vi.mocked(h.applyStatusBarVisibility as () => void).mockClear();
	vi.mocked(h.applyGatedCommandRegistration as () => void).mockClear();
	vi.mocked(refreshNoteZoomControlsAll).mockClear();
	vi.mocked(refreshPenToolsAll).mockClear();
	h.disk = { ...(h.disk as Record<string, unknown>), [key]: to };
	await proto.onExternalSettingsChange.call(h);
	expect((h.settings as Record<string, unknown>)[key], "the synced value was not taken, so this cell proves nothing").toBe(to);
	return { h, after: counts(h) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("another device turning Infinite Canvas on refreshes the header icon on this device", async () => {
	const { after } = await sync("extendCanvasWhileScrolling", false, true);
	expect(after.header, "the synced Infinite Canvas change left the header icon as it was").toBeGreaterThan(0);
});

it("another device turning Infinite Canvas on refreshes the zoom controls on this device", async () => {
	const { after } = await sync("extendCanvasWhileScrolling", false, true);
	expect(after.zoom, "the synced Infinite Canvas change left the zoom controls as they were").toBeGreaterThan(0);
});

it("another device changing the pen tools mode refreshes the pen tools on this device", async () => {
	const { after } = await sync("penTools", "auto", "hide");
	expect(after.penTools, "the synced pen tools mode left the pen tools as they were").toBeGreaterThan(0);
});

it("another device turning the status bar row on updates the status bar on this device", async () => {
	const { after } = await sync("hideStatusBarOnInkedNotes", false, true);
	expect(after.statusBar, "the synced status bar row left the status bar as it was").toBeGreaterThan(0);
});

it("another device turning the colour and size commands row on updates the command palette on this device", async () => {
	const { after } = await sync("colorSizeCommands", false, true);
	expect(after.commands, "the synced commands row left the command palette as it was").toBeGreaterThan(0);
});

it("a save that reads another device's Infinite Canvas change first refreshes the header icon", async () => {
	const h = plugin({ extendCanvasWhileScrolling: false, toolbarCorner: "top-right" });
	await proto.loadSettings.call(h);
	vi.mocked(h.refreshHeaderActions as () => void).mockClear();
	h.disk = { ...(h.disk as Record<string, unknown>), extendCanvasWhileScrolling: true };
	await proto.persistSettings.call(h);
	expect((h.settings as Record<string, unknown>).extendCanvasWhileScrolling, "the save did not take the synced value, so this cell proves nothing").toBe(true);
	expect(counts(h).header, "the save took the synced Infinite Canvas value and left the header icon as it was").toBeGreaterThan(0);
});

/** A refresh that throws, with the error report kept out of the test output. */
function refreshThrows(h: Record<string, unknown>): void {
	vi.spyOn(console, "error").mockImplementation(() => {});
	(h.refreshHeaderActions as ReturnType<typeof vi.fn>).mockImplementation(() => {
		throw new Error("header refresh failed");
	});
}

it("a refresh that throws on a save still writes the merged values and moves the baseline", async () => {
	const h = plugin({ extendCanvasWhileScrolling: false, toolbarCorner: "top-right" });
	await proto.loadSettings.call(h);
	refreshThrows(h);
	// This device moves the toolbar and the other device turns Infinite Canvas on: the save has to carry both.
	(h.settings as Record<string, unknown>).toolbarCorner = "bottom-left";
	h.disk = { ...(h.disk as Record<string, unknown>), extendCanvasWhileScrolling: true };
	await proto.persistSettings.call(h).catch(() => {});
	const disk = h.disk as Record<string, unknown>;
	expect(disk.toolbarCorner, "the save never reached saveData with this device's toolbar corner").toBe("bottom-left");
	expect(disk.extendCanvasWhileScrolling, "the save never reached saveData with the merged Infinite Canvas value").toBe(true);
	expect((h.settingsBaseline as Record<string, unknown>).extendCanvasWhileScrolling, "the baseline did not move to what was written").toBe(true);
});

it("a refresh that throws on a change report still moves the baseline to the file", async () => {
	const h = plugin({ extendCanvasWhileScrolling: false, toolbarCorner: "top-right" });
	await proto.loadSettings.call(h);
	refreshThrows(h);
	h.disk = { ...(h.disk as Record<string, unknown>), extendCanvasWhileScrolling: true };
	await proto.onExternalSettingsChange.call(h).catch(() => {});
	expect((h.settingsBaseline as Record<string, unknown>).extendCanvasWhileScrolling, "the change report left the baseline at the old value").toBe(true);
});

it("another device moving the toolbar corner, a setting outside the four rows above, refreshes every screen on this device", async () => {
	const { after } = await sync("toolbarCorner", "top-right", "bottom-left");
	expect(after.header, "the synced toolbar corner left the header icon as it was").toBeGreaterThan(0);
	expect(after.zoom, "the synced toolbar corner left the zoom controls as they were").toBeGreaterThan(0);
	expect(after.penTools, "the synced toolbar corner left the pen tools as they were").toBeGreaterThan(0);
	expect(after.statusBar, "the synced toolbar corner left the status bar as it was").toBeGreaterThan(0);
	expect(after.commands, "the synced toolbar corner left the command palette as it was").toBeGreaterThan(0);
});
