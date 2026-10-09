/**
 * A pen colour or size picked while a settings save is still writing must
 * reach data.json. After a save's merge the live settings and the object sent
 * to the disk share their colour and size maps, so a pick during the write
 * changed the object the baseline was then taken from: the baseline held the
 * new value and the disk the old one, and the next save read the pick as no
 * change and wrote the disk's old value back. The baseline is now the
 * snapshot of what went to the disk, taken before the write.
 *
 * Harness from src/SettingsSync.test.ts (its model of data.json: saveData
 * serialises at call time, as Obsidian does).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import HandwritingPlugin from "./main";
import { PageIdIndex } from "./model/PageIdIndex";

type Proto = {
	loadSettings(this: unknown): Promise<void>;
	persistSettings(this: unknown, onHide?: boolean): Promise<void>;
};
const proto = HandwritingPlugin.prototype as unknown as Proto;

interface Harness {
	settings: Record<string, unknown> & { inkColors: Record<string, string>; inkSizes: Record<string, number> };
	disk: Record<string, unknown> & { inkColors?: Record<string, string> };
	writes: Record<string, unknown>[];
	settingsWriting: Promise<void> | null;
	saveData: (data: Record<string, unknown>) => Promise<void>;
}

function plugin(disk: Record<string, unknown>): Harness {
	const g = globalThis as unknown as { document?: unknown; window?: unknown };
	g.document ??= { body: { classList: { add: () => {}, toggle: () => {}, contains: () => false } } };
	g.window ??= {
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
		clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
	};
	const p = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	p.disk = { ...disk };
	p.writes = [];
	p.loadData = (): Promise<unknown> => Promise.resolve(JSON.parse(JSON.stringify(p.disk)));
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
	p.manifest = { version: "1.4.23", dir: ".obsidian/plugins/handwriting" };
	p.applyPaperTo = (): void => {};
	p.applyBooxMode = (): void => {};
	return p as unknown as Harness;
}

const settle = async (h: Harness): Promise<void> => {
	for (let i = 0; i < 8; i++) {
		await h.settingsWriting;
		await Promise.resolve();
	}
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a setting changed while a settings save is writing", () => {
	it("keeps a pen colour picked during the write", async () => {
		const h = plugin({ inkColors: { pen: "#111111", highlighter: "#ffee00" }, toolbarCorner: "top-right" });
		await proto.loadSettings.call(h);

		// Hold the first write open: the window a slow disk (mobile) leaves.
		const plainSave = h.saveData;
		let release: () => void = () => {};
		let held = false;
		h.saveData = (data) => {
			if (held) return plainSave(data);
			held = true;
			const done = plainSave(data); // serialised now, as Obsidian does
			return new Promise<void>((resolve) => {
				release = () => void done.then(resolve);
			});
		};

		// Any save starts a write (here: the toolbar was dragged to a corner).
		h.settings.toolbarCorner = "bottom-left";
		void proto.persistSettings.call(h);
		for (let i = 0; i < 4; i++) await Promise.resolve();
		expect(h.writes, "the first write is out and still in flight").toHaveLength(1);

		// The strip's colour writer, during that write.
		h.settings.inkColors.pen = "#ff0000";
		void proto.persistSettings.call(h);

		release();
		await settle(h);

		expect(h.disk.inkColors?.pen, "the colour picked during the write never reached data.json").toBe("#ff0000");
		expect(h.settings.inkColors.pen, "memory was put back to the old colour").toBe("#ff0000");
	});

	it("keeps a pen size committed during the write (same mechanism, inkSizes map)", async () => {
		const h = plugin({ inkSizes: { pen: 1, highlighter: 1 } });
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
		expect(h.writes).toHaveLength(1);

		// The slider release and preset path.
		h.settings.inkSizes.pen = 2;
		void proto.persistSettings.call(h);
		release();
		await settle(h);

		expect((h.disk.inkSizes as Record<string, number>).pen).toBe(2);
		expect(h.settings.inkSizes.pen).toBe(2);
	});

	it("with no pick during the write, the baseline is what the disk holds", async () => {
		const h = plugin({ inkColors: { pen: "#111111", highlighter: "#ffee00" }, toolbarCorner: "top-right" });
		await proto.loadSettings.call(h);
		h.settings.toolbarCorner = "bottom-left";
		void proto.persistSettings.call(h);
		await settle(h);
		expect(h.writes).toHaveLength(1);
		expect((h as unknown as { settingsBaseline: unknown }).settingsBaseline).toEqual(h.disk);
	});
});
