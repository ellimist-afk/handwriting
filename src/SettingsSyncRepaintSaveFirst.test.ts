/**
 * Another device turns pressure sensitivity off; data.json lands.
 * Before Obsidian calls onExternalSettingsChange, this device saves anything
 * (a colour pick, the eraser slider, the ownership ledger's 2 s flush). The
 * save reads the file first and takes the other device's value through
 * takeMergedSettings - which applies it but redraws nothing. The change
 * report that follows then sees no shaping change, so nothing ever redraws.
 * Same rig as SettingsSyncRepaint.test.ts, with one save in between.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./inline/InkOverlay", async (importOriginal) => {
	const real = await importOriginal<typeof import("./inline/InkOverlay")>();
	return { ...real, repaintAllInkOverlays: vi.fn() };
});
vi.mock("./inline/EmbedInk", async (importOriginal) => {
	const real = await importOriginal<typeof import("./inline/EmbedInk")>();
	return { ...real, embedInkRepaintAll: vi.fn() };
});

import HandwritingPlugin from "./main";
import { PageIdIndex } from "./model/PageIdIndex";
import { repaintAllInkOverlays } from "./inline/InkOverlay";
import { embedInkRepaintAll } from "./inline/EmbedInk";

type Proto = {
	loadSettings(this: unknown): Promise<void>;
	onExternalSettingsChange(this: unknown): Promise<void>;
	persistSettings(this: unknown): Promise<void>;
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
	p.gatedCommandDefs = new Map();
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
	return p;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	vi.mocked(repaintAllInkOverlays).mockClear();
	vi.mocked(embedInkRepaintAll).mockClear();
});

for (const [key, from, to] of [
	["pressureSensitivity", true, false],
	["inkSmoothing", true, false],
	["inkAdaptsToTheme", false, true],
] as const) {
	it(`a synced ${key} change still redraws when a local save reads the file first`, async () => {
		const h = plugin({ [key]: from, pressureChoice: key === "pressureSensitivity" ? from : undefined });
		await proto.loadSettings.call(h);
		vi.mocked(repaintAllInkOverlays).mockClear();
		vi.mocked(embedInkRepaintAll).mockClear();
		// The other device's file lands.
		const synced = { ...(h.disk as Record<string, unknown>), [key]: to };
		if (key === "pressureSensitivity") synced.pressureChoice = to;
		h.disk = synced;
		// This device saves something unrelated before the change report arrives.
		(h.settings as Record<string, unknown>).eraserRadiusPx = 28;
		await proto.persistSettings.call(h);
		await proto.onExternalSettingsChange.call(h);
		expect((h.settings as Record<string, unknown>)[key], "the synced value was not taken, so this cell proves nothing").toBe(to);
		expect(vi.mocked(repaintAllInkOverlays).mock.calls.length, `ink on screen kept the old ${key}`).toBeGreaterThan(0);
	});
}
