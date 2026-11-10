/**
 * Every pen and highlighter colour slot is a setting (1.5.0): two maps,
 * penPalette {"0".."7": hex} and highlighterPalette {"0".."4": hex}, each a
 * top-level key so the one-level merge keeps two devices' edits to different
 * slots of one tool. Read slot by slot on load; pushed into the live palette
 * on load and whenever another device's value is taken.
 *
 * Harness from src/SettingsSync.test.ts (its model of data.json: saveData
 * serialises at call time, as Obsidian does).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import HandwritingPlugin from "./main";
import { PageIdIndex } from "./model/PageIdIndex";
import { DEFAULT_SETTINGS } from "./settings/SettingsModel";
import { HIGHLIGHTER_COLORS, PEN_COLORS, colorsFor, setInkColorHex, setInkPalette } from "./ink/InkColor";

type Proto = {
	loadSettings(this: unknown): Promise<void>;
	persistSettings(this: unknown, onHide?: boolean): Promise<void>;
	onExternalSettingsChange(this: unknown): Promise<void>;
};
const proto = HandwritingPlugin.prototype as unknown as Proto;

interface Harness {
	settings: Record<string, unknown> & { penPalette: Record<string, string>; highlighterPalette: Record<string, string> };
	disk: Record<string, unknown> | undefined;
	reads: number;
	writes: Record<string, unknown>[];
	pageIds: PageIdIndex;
	settingsWriting: Promise<void> | null;
	saveData: (data: Record<string, unknown>) => Promise<void>;
}


function plugin(disk: Record<string, unknown> | undefined): Harness {
	const g = globalThis as unknown as { document?: unknown; window?: unknown };
	g.document ??= { body: { classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false } } };
	g.window ??= {
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
		clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
	};
	const p = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	p.gatedCommandDefs = new Map();
	p.disk = disk === undefined ? undefined : { ...disk };
	p.reads = 0;
	p.writes = [];
	p.loadData = (): Promise<unknown> => {
		(p.reads as number)++;
		const d = p.disk as Record<string, unknown> | undefined;
		return Promise.resolve(d === undefined ? undefined : JSON.parse(JSON.stringify(d)));
	};
	p.saveData = (data: Record<string, unknown>): Promise<void> => {
		const copy = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
		(p.writes as Record<string, unknown>[]).push(copy);
		p.disk = copy;
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
	return p as unknown as Harness;
}

const settle = async (h: Harness): Promise<void> => {
	for (let i = 0; i < 5; i++) {
		await h.settingsWriting;
		await Promise.resolve();
	}
};

const slots = (hexes: readonly string[]): Record<string, string> =>
	Object.fromEntries(hexes.map((h, i) => [String(i), h]));
const penDefaults = PEN_COLORS.map((c) => c.hex);
const highlighterDefaults = HIGHLIGHTER_COLORS.map((c) => c.hex);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	setInkPalette("pen", penDefaults);
	setInkPalette("highlighter", highlighterDefaults);
	setInkColorHex("pen", penDefaults[0]);
	setInkColorHex("highlighter", highlighterDefaults[0]);
});

describe("the palette settings", () => {
	it("default to the shipped colours, one string key per slot", () => {
		const d = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
		expect(d.penPalette).toEqual(slots(penDefaults));
		expect(d.highlighterPalette).toEqual(slots(highlighterDefaults));
	});

	it("load slot by slot: a bad slot gets its default, the rest are kept, and the live palette follows", async () => {
		const pen = slots(penDefaults);
		pen["2"] = "#0A0B0C";
		pen["5"] = "nope";
		const h = plugin({ penPalette: pen, highlighterPalette: { "0": "#123456", "9": "#000000" } });
		await proto.loadSettings.call(h);
		const wantPen = [...penDefaults];
		wantPen[2] = "#0a0b0c";
		expect(h.settings.penPalette).toEqual(slots(wantPen));
		expect(h.settings.highlighterPalette).toEqual(slots(["#123456", ...highlighterDefaults.slice(1)]));
		expect(colorsFor("pen").map((c) => c.hex)).toEqual(wantPen);
		expect(colorsFor("highlighter")[0]!.hex).toBe("#123456");
	});

	it("a file with no palette loads the shipped colours", async () => {
		const h = plugin({});
		await proto.loadSettings.call(h);
		expect(h.settings.penPalette).toEqual(slots(penDefaults));
		expect(h.settings.highlighterPalette).toEqual(slots(highlighterDefaults));
	});

	it("two devices editing different slots of one tool both keep theirs", async () => {
		const h = plugin({ penPalette: slots(penDefaults) });
		await proto.loadSettings.call(h);
		// The other device edits pen slot 5 and saves.
		h.disk = { ...h.disk, penPalette: { ...(h.disk!.penPalette as Record<string, string>), "5": "#555555" } };
		// This device edits pen slot 2 and saves.
		h.settings.penPalette["2"] = "#222222";
		await proto.persistSettings.call(h);
		await settle(h);
		const want = slots(penDefaults);
		want["2"] = "#222222";
		want["5"] = "#555555";
		expect(h.disk!.penPalette).toEqual(want);
		expect(h.settings.penPalette).toEqual(want);
		expect(colorsFor("pen")[5]!.hex, "the other device's slot is in the live palette").toBe("#555555");
	});

	it("another device's slot edit reaches the live palette when the file changes", async () => {
		const h = plugin({ highlighterPalette: slots(highlighterDefaults) });
		await proto.loadSettings.call(h);
		h.disk = { ...h.disk, highlighterPalette: { ...(h.disk!.highlighterPalette as Record<string, string>), "3": "#333333" } };
		await proto.onExternalSettingsChange.call(h);
		await settle(h);
		expect(colorsFor("highlighter")[3]!.hex).toBe("#333333");
	});

	it("a slot edited while a settings save is writing reaches data.json", async () => {
		const h = plugin({ penPalette: slots(penDefaults), toolbarCorner: "top-right" });
		await proto.loadSettings.call(h);
		const plainSave = h.saveData;
		let release: () => void = () => {};
		let held = false;
		h.saveData = (data) => {
			if (held) return plainSave(data);
			held = true;
			const done = plainSave(data);
			return new Promise<void>((resolve) => {
				release = () => void done.then(resolve);
			});
		};
		h.settings.toolbarCorner = "bottom-left";
		void proto.persistSettings.call(h);
		for (let i = 0; i < 4; i++) await Promise.resolve();
		expect(h.writes, "the first write is out and still in flight").toHaveLength(1);

		h.settings.penPalette["6"] = "#abcdef";
		void proto.persistSettings.call(h);
		release();
		await settle(h);

		expect((h.disk!.penPalette as Record<string, string>)["6"], "the slot edited during the write never reached data.json").toBe("#abcdef");
		expect(h.settings.penPalette["6"], "memory was put back to the old colour").toBe("#abcdef");
	});
});
