/**
 * data.json IS SHARED BY EVERY DEVICE THAT SYNCS THE VAULT, and a device must
 * neither put its stale copy over another device's change nor put defaults
 * over a file it could not read.
 *
 * Drives the real loadSettings, persistSettings, flushSettings, flushOnHide,
 * persistOwners and onExternalSettingsChange off HandwritingPlugin.prototype,
 * over a fake data.json whose reads and writes are counted. Obsidian's
 * loadData returns null for a missing file and undefined for one that could
 * not be read or parsed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import HandwritingPlugin from "./main";
import { PageIdIndex } from "./model/PageIdIndex";

type Proto = {
	loadSettings(this: unknown): Promise<void>;
	persistSettings(this: unknown, onHide?: boolean): Promise<void>;
	persistOwners(this: unknown): void;
	flushOnHide(this: unknown): void;
	onExternalSettingsChange(this: unknown): Promise<void>;
};
const proto = HandwritingPlugin.prototype as unknown as Proto;

interface Harness {
	settings: Record<string, unknown>;
	/** data.json on this device's disk; undefined = unreadable. */
	disk: Record<string, unknown> | undefined;
	reads: number;
	writes: Record<string, unknown>[];
	pageIds: PageIdIndex;
	settingsWriting: Promise<void> | null;
	store: { flushDispatch(): void; useInkFolder(f: string): void };
}

function plugin(disk: Record<string, unknown> | undefined): Harness {
	const g = globalThis as unknown as { document?: unknown; window?: unknown };
	g.document ??= { body: { classList: { add: () => {}, toggle: () => {}, contains: () => false } } };
	g.window ??= {
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
		clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
	};
	const p = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
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

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("settings shared between devices", () => {
	it("a data.json that cannot be read is never overwritten with defaults, and a clean read later keeps its values", async () => {
		const h = plugin(undefined);
		const loading = proto.loadSettings.call(h);
		await vi.advanceTimersByTimeAsync(1000);
		await loading;
		expect(h.reads, "the read was retried").toBe(4);
		// The session runs on defaults; a change and every kind of save write nothing.
		h.settings.toolbarCorner = "bottom-left";
		await proto.persistSettings.call(h);
		h.pageIds.register("note.md", "page01");
		proto.persistOwners.call(h);
		await vi.advanceTimersByTimeAsync(3000);
		proto.flushOnHide.call(h);
		await settle(h);
		expect(h.writes, "defaults were written over an unreadable settings file").toEqual([]);

		// The file becomes readable (another device's save syncs in).
		h.disk = { pressureSensitivity: false, inkFolder: "handwriting", toolbarCorner: "top-right" };
		await proto.onExternalSettingsChange.call(h);
		await settle(h);
		expect(h.settings.pressureSensitivity, "the file's value was taken").toBe(false);
		expect(h.settings.inkFolder).toBe("handwriting");
		// The one change made this session is kept and now saved, over the file.
		expect(h.settings.toolbarCorner).toBe("bottom-left");
		expect(h.disk).toMatchObject({ pressureSensitivity: false, inkFolder: "handwriting", toolbarCorner: "bottom-left" });
	});

	it("another device's change survives this device's save of a different key, even with no change signal", async () => {
		const h = plugin({ pressureSensitivity: true, toolbarCorner: "top-right" });
		await proto.loadSettings.call(h);
		// The other device's save syncs in; Obsidian says nothing this time.
		h.disk = { ...h.disk, pressureSensitivity: false };
		h.settings.toolbarCorner = "top-left";
		await proto.persistSettings.call(h);
		await settle(h);
		expect(h.disk).toMatchObject({ pressureSensitivity: false, toolbarCorner: "top-left" });
		// And memory follows the file, so the next save does not revert it either.
		expect(h.settings.pressureSensitivity).toBe(false);
		h.settings.shapeSnap = false;
		await proto.persistSettings.call(h);
		await settle(h);
		expect(h.disk).toMatchObject({ pressureSensitivity: false, toolbarCorner: "top-left", shapeSnap: false });
	});

	it("the flush on hide writes without reading first, so nothing is awaited in front of the write", async () => {
		const h = plugin({ toolbarCorner: "top-right" });
		await proto.loadSettings.call(h);
		const readsBefore = h.reads;
		h.settings.toolbarCorner = "bottom-right";
		(h as unknown as { settingsDirty: boolean }).settingsDirty = true;
		proto.flushOnHide.call(h);
		// Synchronously: the write is already out.
		expect(h.writes, "the hide flush did not dispatch its write synchronously").toHaveLength(1);
		expect(h.reads, "the hide flush read the file first").toBe(readsBefore);
		expect(h.writes[0]).toMatchObject({ toolbarCorner: "bottom-right" });
	});

	it("page owners from two devices both survive, and an owner this device removed stays removed", async () => {
		const h = plugin({ pageOwners: { shared01: "shared.md", gone01: "gone.md" } });
		await proto.loadSettings.call(h);
		// The other device claims a page; its save syncs in.
		h.disk = { ...h.disk, pageOwners: { shared01: "shared.md", gone01: "gone.md", theirs01: "theirs.md" } };
		// This device claims one and drops one.
		h.settings.pageOwners = { shared01: "shared.md", mine01: "mine.md" };
		await proto.persistSettings.call(h);
		await settle(h);
		expect(h.disk!.pageOwners).toEqual({ shared01: "shared.md", theirs01: "theirs.md", mine01: "mine.md" });
	});

	// A setting that is itself a small map (the pen and highlighter colours,
	// sizes, page owners, saved cameras) merges entry by entry: one device's
	// pen colour and the other device's highlighter colour both survive.
	for (const [label, mine, theirs] of [
		["this device sets the highlighter, the other the pen", "highlighter", "pen"],
		["this device sets the pen, the other the highlighter", "pen", "highlighter"],
	] as const) {
		it(`two devices changing different entries of one setting both keep theirs: ${label}`, async () => {
			const h = plugin({ inkColors: { pen: "#111111", highlighter: "#ffff00" } });
			await proto.loadSettings.call(h);
			const other = theirs === "pen" ? "#222222" : "#00ffff";
			const own = mine === "pen" ? "#333333" : "#00ff00";
			h.disk = { ...h.disk, inkColors: { ...(h.disk!.inkColors as Record<string, string>), [theirs]: other } };
			(h.settings.inkColors as Record<string, string>)[mine] = own;
			await proto.persistSettings.call(h);
			await settle(h);
			expect(h.disk!.inkColors).toEqual({ [theirs]: other, [mine]: own });
		});
	}

	it("a key this device changed and saved follows the file again once the other device changes it", async () => {
		const h = plugin({ toolbarCorner: "top-right" });
		await proto.loadSettings.call(h);
		// This device changes the key and saves it.
		h.settings.toolbarCorner = "bottom-left";
		await proto.persistSettings.call(h);
		await settle(h);
		expect(h.disk).toMatchObject({ toolbarCorner: "bottom-left" });
		// The other device then changes the same key; its save syncs in.
		h.disk = { ...h.disk, toolbarCorner: "top-left" };
		// This device saves something else.
		h.settings.shapeSnap = false;
		await proto.persistSettings.call(h);
		await settle(h);
		expect(h.disk, "this device's earlier change reverted the other device's later one").toMatchObject({
			toolbarCorner: "top-left",
			shapeSnap: false,
		});
	});
});
