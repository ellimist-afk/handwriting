/**
 * A SYNCED CHANGE TO THE PRESSURE SETTING REDRAWS THE INK ALREADY ON SCREEN.
 *
 * Saved strokes are shaped at draw time from their stored samples, so the
 * pressure switch changes how ink already on the page looks. The settings tab
 * redraws every overlay, embed and reading view when it flips the switch.
 * When the same change arrives from another device (data.json syncs in and
 * onExternalSettingsChange applies it), nothing redraws: the next partial
 * repaint redraws only inside its own rectangle, so a stroke crossing that
 * rectangle's edge shows two widths with a seam until a full repaint.
 *
 * Drives the real onExternalSettingsChange off HandwritingPlugin.prototype
 * over a fake data.json, with the two redraw fan-outs spied.
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
afterEach(() => { vi.useRealTimers(); vi.mocked(repaintAllInkOverlays).mockClear(); vi.mocked(embedInkRepaintAll).mockClear(); });

it("another device turning pressure off redraws every overlay and every embed on this device", async () => {
	const h = plugin({ pressureSensitivity: true, toolbarCorner: "top-right" });
	await proto.loadSettings.call(h);
	vi.mocked(repaintAllInkOverlays).mockClear();
	vi.mocked(embedInkRepaintAll).mockClear();
	h.disk = { ...(h.disk as Record<string, unknown>), pressureSensitivity: false };
	await proto.onExternalSettingsChange.call(h);
	expect((h.settings as Record<string, unknown>).pressureSensitivity, "the synced value was not taken, so this cell proves nothing").toBe(false);
	expect(vi.mocked(repaintAllInkOverlays).mock.calls.length, "the synced pressure change left every overlay's ink in its old width").toBeGreaterThan(0);
	expect(vi.mocked(embedInkRepaintAll).mock.calls.length, "the synced pressure change left embeds and reading views in their old width").toBeGreaterThan(0);
});

/** Sync one key from `from` to `to`; return the two fan-outs' call counts. */
async function sync(key: string, from: unknown, to: unknown): Promise<{ overlays: number; embeds: number; taken: unknown }> {
	const h = plugin({ [key]: from, toolbarCorner: "top-right" });
	await proto.loadSettings.call(h);
	vi.mocked(repaintAllInkOverlays).mockClear();
	vi.mocked(embedInkRepaintAll).mockClear();
	h.disk = { ...(h.disk as Record<string, unknown>), [key]: to };
	await proto.onExternalSettingsChange.call(h);
	return {
		overlays: vi.mocked(repaintAllInkOverlays).mock.calls.length,
		embeds: vi.mocked(embedInkRepaintAll).mock.calls.length,
		taken: (h.settings as Record<string, unknown>)[key],
	};
}

it("another device turning ink smoothing off redraws every overlay and every embed on this device", async () => {
	const r = await sync("inkSmoothing", true, false);
	expect(r.taken, "the synced value was not taken, so this cell proves nothing").toBe(false);
	expect(r.overlays, "the synced smoothing change left every overlay's ink in its old shape").toBeGreaterThan(0);
	expect(r.embeds, "the synced smoothing change left embeds and reading views in their old shape").toBeGreaterThan(0);
});

it("another device turning Boox mode on redraws every overlay and every embed on this device", async () => {
	const r = await sync("booxMode", false, true);
	expect(r.taken, "the synced value was not taken, so this cell proves nothing").toBe(true);
	expect(r.overlays, "the synced Boox mode change left every overlay's ink in its old shape").toBeGreaterThan(0);
	expect(r.embeds, "the synced Boox mode change left embeds and reading views in their old shape").toBeGreaterThan(0);
});

it("another device turning ink theme adaptation on redraws every overlay on this device", async () => {
	const r = await sync("inkAdaptsToTheme", false, true);
	expect(r.taken, "the synced value was not taken, so this cell proves nothing").toBe(true);
	expect(r.overlays, "the synced theme adaptation left every overlay's ink in its old colour").toBeGreaterThan(0);
});

it("a synced change that does not shape ink (the toolbar corner) redraws nothing", async () => {
	const r = await sync("toolbarCorner", "top-right", "top-left");
	expect(r.taken, "the synced value was not taken, so this cell proves nothing").toBe("top-left");
	expect(r.overlays, "a sync that changes no ink redrew every overlay").toBe(0);
	expect(r.embeds, "a sync that changes no ink redrew every embed").toBe(0);
});
