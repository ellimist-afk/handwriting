/**
 * Audit probe main-3-1 (1.4.21 at 1a05f62c). Claim: a data.json that fails to
 * read or parse comes back from Obsidian's loadData as `undefined` (not null),
 * so loadSettings builds pure defaults with freshInstall=false, and the
 * layout-ready what's-new record then saves those defaults over data.json with
 * no user action.
 *
 * Real production code under test: HandwritingPlugin.prototype.loadSettings and
 * showWhatsNewIfDue (main.ts), persistSettings, decideWhatsNew, adoptInkFolder.
 * The only fakes are the host boundaries: the disk, and Obsidian's loadData,
 * which mirrors Vault.readJson in Obsidian 1.13.7 app.js (@1388xxx):
 *   try { return JSON.parse(await adapter.read(p)) }
 *   catch (r) { if (r.code === "ENOENT") return null; console.error(...); return undefined }
 * Harness copied from src/PressureUpgradeNotice.test.ts.
 *
 * Assertions state the CORRECT behaviour: a failed read must not end with the
 * user's valid settings replaced on disk. Red means the bug is real.
 */
import { describe, expect, it } from "vitest";
import HandwritingPlugin from "../main";

class FakeEl {
	children: FakeEl[] = [];
	constructor(public tag: string, public cls?: string, public text?: string) {}
	createDiv(opts: { cls?: string; text?: string } = {}): FakeEl {
		const el = new FakeEl("div", opts.cls, opts.text);
		this.children.push(el);
		return el;
	}
	createEl(tag: string, opts: { cls?: string; text?: string } = {}): FakeEl {
		const el = new FakeEl(tag, opts.cls, opts.text);
		this.children.push(el);
		return el;
	}
}
(globalThis as unknown as { createFragment: () => FakeEl }).createFragment = () =>
	new FakeEl("fragment");

function ensureDocument(): void {
	const g = globalThis as unknown as { document?: unknown; window?: unknown };
	g.document ??= {
		body: { classList: { add: () => {}, toggle: () => {}, contains: () => false } },
	};
	// loadSettings waits between read attempts with window.setTimeout.
	g.window ??= {
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
		clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
	};
}

const proto = HandwritingPlugin.prototype as unknown as {
	loadSettings(this: unknown): Promise<void>;
	showWhatsNewIfDue(this: unknown): void;
};

/** The user's real, valid settings file as it sits on disk before launch. */
const STORED = {
	pressureSensitivity: false,
	inkFolder: "handwriting",
	lastSeenVersion: "1.4.21",
	cameras: { "Notes/Plan.md": { zoom: 2, x: 40, y: 80 } },
};
const STORED_TEXT = JSON.stringify(STORED, null, 2);

type Disk = {
	text: string | null; // null = data.json missing
	readError: { code: string } | null; // one-shot non-ENOENT read failure (lock)
	writes: string[];
};

type Launch = {
	loadDataReturned: unknown;
	folder: string | null;
	settings: Record<string, unknown>;
	freshInstall: unknown;
};

/** Vault adapter: the synced `handwriting/` folder holds one live sidecar. */
function vaultAdapter() {
	const files: Record<string, string[]> = { handwriting: ["handwriting/p1.json"] };
	return {
		exists: async (p: string) => p === "handwriting" || p === "handwriting/p1.json",
		list: async (p: string) => ({ files: files[p] ?? [], folders: [] }),
		mkdir: async () => {},
		rename: async () => {},
		read: async () => "",
		write: async () => {},
		remove: async () => {},
	};
}

async function launch(disk: Disk, version = "1.4.21"): Promise<Launch> {
	ensureDocument();
	const out: Launch = { loadDataReturned: "unset", folder: null, settings: {}, freshInstall: "unset" };
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	// Obsidian 1.13.7 Plugin.loadData -> vault.readPluginData -> readJson.
	plugin.loadData = async (): Promise<unknown> => {
		let result: unknown;
		try {
			if (disk.readError) {
				const e = disk.readError;
				disk.readError = null;
				throw e;
			}
			if (disk.text === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			result = JSON.parse(disk.text);
		} catch (r) {
			result = (r as { code?: string }).code === "ENOENT" ? null : undefined;
		}
		// The FIRST read is what the host reported at launch; a retry may read again.
		if (out.loadDataReturned === "unset") out.loadDataReturned = result;
		return result;
	};
	plugin.saveData = async (data: unknown): Promise<void> => {
		disk.text = JSON.stringify(data, null, 2);
		disk.writes.push(disk.text);
	};
	plugin.settingsTimer = null;
	plugin.settingsDirty = false;
	plugin.settingsWriting = null;
	plugin.settingsWriteAgain = false;
	plugin.store = {
		useInkFolder: (f: string) => {
			out.folder = f;
		},
		holdWrites: () => {},
		releaseWrites: () => {},
		load: () => null,
		schedule: () => {},
	};
	plugin.pdfStore = { attachHost: () => {} };
	plugin.app = { workspace: { onLayoutReady: () => {} }, vault: { adapter: vaultAdapter() } };
	plugin.applyPaperTo = (): void => {};
	plugin.applyBooxMode = (): void => {};
	plugin.manifest = { version };
	plugin.freshInstall = false;
	// onload: await loadSettings; then at layout ready: showWhatsNewIfDue (main.ts:3684-3686).
	await proto.loadSettings.call(plugin);
	proto.showWhatsNewIfDue.call(plugin);
	// Let any detached persistSettings finish.
	await (plugin.settingsWriting as Promise<void> | null);
	await Promise.resolve();
	out.settings = plugin.settings as Record<string, unknown>;
	out.freshInstall = plugin.freshInstall;
	return out;
}

describe("main-3-1: an unreadable data.json must not be replaced by defaults", () => {
	it("control: a readable data.json loads the user's settings and launch writes nothing", async () => {
		const disk: Disk = { text: STORED_TEXT, readError: null, writes: [] };
		const r = await launch(disk);
		expect(r.loadDataReturned).toEqual(STORED);
		expect(r.settings.pressureSensitivity).toBe(false);
		expect(r.settings.inkFolder).toBe("handwriting");
		expect(r.folder).toBe("handwriting");
		expect(disk.writes.length).toBe(0);
		expect(JSON.parse(disk.text!)).toEqual(STORED);
	});

	it("transient lock (EBUSY) on a VALID data.json: the file on disk keeps the user's settings after launch", async () => {
		const disk: Disk = { text: STORED_TEXT, readError: { code: "EBUSY" }, writes: [] };
		const r = await launch(disk);
		// Precondition: the host reported a failed (non-missing) read, not a missing file.
		expect(r.loadDataReturned).toBeUndefined();
		expect(r.freshInstall).toBe(false);
		// Correct behaviour: the valid file was not overwritten with defaults.
		const onDisk = JSON.parse(disk.text!) as Record<string, unknown>;
		expect(
			{
				writes: disk.writes.length,
				pressureSensitivity: onDisk.pressureSensitivity,
				inkFolder: onDisk.inkFolder,
				cameras: onDisk.cameras,
			},
			"data.json after a launch whose read hit EBUSY"
		).toEqual({
			writes: 0,
			pressureSensitivity: false,
			inkFolder: "handwriting",
			cameras: STORED.cameras,
		});
	});

	it("truncated data.json (invalid JSON): ink folder recovery runs as for a missing file, and the damaged file is not silently replaced", async () => {
		const truncated = STORED_TEXT.slice(0, Math.floor(STORED_TEXT.length / 2));
		expect(() => JSON.parse(truncated)).toThrow();

		// Reference: data.json missing entirely -> adoptInkFolder picks the synced folder in use.
		const missing: Disk = { text: null, readError: null, writes: [] };
		const ref = await launch(missing);
		expect(ref.loadDataReturned).toBeNull();
		expect(ref.folder).toBe("handwriting");

		const disk: Disk = { text: truncated, readError: null, writes: [] };
		const r = await launch(disk);
		expect(r.loadDataReturned).toBeUndefined();
		expect(
			{ folder: r.folder, writes: disk.writes.length },
			"store folder and data.json writes after a launch on a truncated data.json"
		).toEqual({ folder: "handwriting", writes: 0 });
	});
});
