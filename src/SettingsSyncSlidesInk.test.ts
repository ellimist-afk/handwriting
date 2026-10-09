/**
 * A SLIDES INK SETTING THAT SYNCS IN FROM ANOTHER DEVICE REACHES THE LIVE SLIDES INK.
 *
 * `slidesInk` is read at startup (startSlidesInk when it is on) and flipped live by the "Toggle slides ink" command, which also
 * starts or stops the live deck (setSlidesInk) and retires its writer. When data.json syncs in with the other device's
 * `slidesInk` the value lands in this.settings through takeMergedSettings, and nothing starts or stops the deck, so this device's
 * presentations keep drawing, or keep refusing to draw, by the old value until the plugin reloads.
 *
 * Drives the real onExternalSettingsChange over a fake data.json, as SettingsSyncSurfaces.test.ts does. The slides module's setter
 * is spied; startSlidesInk is a spy on the instance.
 *
 * Oracle: after the value syncs in, an ON value has started the slides ink and an OFF value has stopped it (setSlidesInk(false)).
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
vi.mock("./slides/SlidesInkSurface", async (importOriginal) => {
	const real = await importOriginal<typeof import("./slides/SlidesInkSurface")>();
	return { ...real, setSlidesInk: vi.fn() };
});

import HandwritingPlugin from "./main";
import { PageIdIndex } from "./model/PageIdIndex";
import { setSlidesInk } from "./slides/SlidesInkSurface";

type Proto = {
	loadSettings(this: unknown): Promise<void>;
	onExternalSettingsChange(this: unknown): Promise<void>;
	persistSettings(this: unknown, onHide?: boolean): Promise<void>;
};
const proto = HandwritingPlugin.prototype as unknown as Proto;

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
	p.startSlidesInk = vi.fn();
	p.slidesWriter = null;
	return p;
}


beforeEach(() => { vi.useFakeTimers(); vi.mocked(setSlidesInk).mockClear(); });
afterEach(() => vi.useRealTimers());

/** Load with slidesInk at `from`, sync `to` in from disk through the change report, and say what the slides ink was told. */
async function sync(from: unknown, to: unknown, key = "slidesInk"): Promise<{ started: number; stopped: number; settings: Record<string, unknown> }> {
	const h = plugin({ [key]: from, toolbarCorner: "top-right" });
	await proto.loadSettings.call(h);
	vi.mocked(setSlidesInk).mockClear();
	vi.mocked(h.startSlidesInk as () => void).mockClear();
	h.disk = { ...(h.disk as Record<string, unknown>), [key]: to };
	await proto.onExternalSettingsChange.call(h);
	const calls = vi.mocked(setSlidesInk).mock.calls;
	return { started: vi.mocked(h.startSlidesInk as () => void).mock.calls.length, stopped: calls.filter((c) => c[0] === false).length, settings: h.settings as Record<string, unknown> };
}

it("control: a synced change to a setting that is not slidesInk starts and stops no slides ink", async () => {
	const r = await sync("top-right", "bottom-left", "toolbarCorner");
	expect(r.settings.toolbarCorner, "premise: the synced value was taken").toBe("bottom-left");
	expect({ started: r.started, stopped: r.stopped }).toEqual({ started: 0, stopped: 0 });
});

it("control: a sync that leaves slidesInk as it was starts and stops no slides ink", async () => {
	const r = await sync(true, true);
	expect({ started: r.started, stopped: r.stopped }).toEqual({ started: 0, stopped: 0 });
});

it("another device turning slides ink off stops the slides ink on this device", async () => {
	const r = await sync(true, false);
	expect(r.settings.slidesInk, "premise: the synced value was taken").toBe(false);
	expect(r.stopped, "the synced OFF value left the slides ink running (setSlidesInk(false) never called)").toBeGreaterThan(0);
});

it("another device turning slides ink on starts the slides ink on this device", async () => {
	const r = await sync(false, true);
	expect(r.settings.slidesInk, "premise: the synced value was taken").toBe(true);
	expect(r.started, "the synced ON value never started the slides ink (startSlidesInk never called)").toBeGreaterThan(0);
});
