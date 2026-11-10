/**
 * The 1.5.0 notes stay on screen until tapped. That one release opens its notice with no timeout, closes it on a tap
 * or click, and records the version on that tap, not at launch: someone who quits without tapping sees it again on the
 * next launch, and on every launch after, until they tap it. Every other release keeps the timed toast, recorded at
 * launch.
 *
 * Runs the real loadSettings and showWhatsNewIfDue on a bare plugin. The `obsidian` package ships no runtime, so the
 * Notice below records what the plugin asked for and lets a test tap it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Tap = () => void;
const shown = vi.hoisted(() => ({
	notices: [] as { message: unknown; duration: number; taps: Tap[]; hidden: number }[],
}));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			containerEl: { addEventListener(type: string, fn: Tap): void };
			messageEl: { isConnected: boolean };
			private entry: { message: unknown; duration: number; taps: Tap[]; hidden: number };
			constructor(message: unknown, duration?: number) {
				const entry = { message, duration: duration ?? -1, taps: [] as Tap[], hidden: 0 };
				this.entry = entry;
				shown.notices.push(entry);
				this.containerEl = { addEventListener: (type: string, fn: Tap) => { if (type === "click") entry.taps.push(fn); } };
				this.messageEl = { isConnected: true };
			}
			hide(): void {
				this.entry.hidden++;
			}
		},
	};
});

const override = vi.hoisted(() => ({ notes: null as Record<string, string[]> | null }));
vi.mock("./WhatsNew", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	const real = actual.decideWhatsNew as (...args: unknown[]) => unknown;
	return {
		...actual,
		decideWhatsNew: (current: unknown, seen: unknown, fresh: unknown, notes?: unknown) =>
			real(current, seen, fresh, notes ?? override.notes ?? undefined),
	};
});

import HandwritingPlugin from "../main";
import { RELEASE_NOTES, whatsNewDurationMs } from "./WhatsNew";
import { setLegacyPressureStore } from "../settings/LegacyPressureLock";

const device = new Map<string, string>();
setLegacyPressureStore({ load: (k) => device.get(k) ?? null, save: (k, v) => void device.set(k, v) });

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
(globalThis as unknown as { createFragment: () => FakeEl }).createFragment = () => new FakeEl("fragment");

const proto = HandwritingPlugin.prototype as unknown as {
	loadSettings(this: unknown): Promise<void>;
	showWhatsNewIfDue(this: unknown): void;
};

type Plugin = { settings: Record<string, unknown>; saved: Record<string, unknown> | null };

/** Wait for the plugin's own settings write chain (persistSettings keeps it in settingsWriting) to finish, not a timer. */
async function settingsWritten(plugin: Record<string, unknown>): Promise<void> {
	while (plugin.settingsWriting) await (plugin.settingsWriting as Promise<void>);
}

function ensureDocument(): void {
	const g = globalThis as unknown as { document?: unknown };
	g.document ??= { body: { classList: { add: () => {}, toggle: () => {}, contains: () => false } } };
}

/** One launch landing on `version`, with a notes table that has an entry for it. */
async function launched(raw: unknown, version: string): Promise<Plugin> {
	ensureDocument();
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.loadData = (): Promise<unknown> => Promise.resolve(raw);
	plugin.saved = null;
	plugin.saveData = (data: Record<string, unknown>): Promise<void> => {
		plugin.saved = { ...data };
		return Promise.resolve();
	};
	plugin.settingsTimer = null;
	plugin.settingsDirty = false;
	plugin.settingsWriting = null;
	plugin.settingsWriteAgain = false;
	plugin.store = { useInkFolder: () => {}, load: () => null, schedule: () => {} };
	plugin.pdfStore = { attachHost: () => {} };
	plugin.app = { workspace: { onLayoutReady: () => {} } };
	plugin.applyPaperTo = (): void => {};
	plugin.applyBooxMode = (): void => {};
	plugin.manifest = { version };
	plugin.freshInstall = false;
	await proto.loadSettings.call(plugin);
	override.notes = { ...RELEASE_NOTES, [version]: ["a note"] };
	try {
		proto.showWhatsNewIfDue.call(plugin);
	} finally {
		override.notes = null;
	}
	// Let the detached saves land.
	await settingsWritten(plugin);
	return plugin as unknown as Plugin;
}

/** The settings the next launch reads: what was saved, else what was there. */
const next = (raw: Record<string, unknown>, p: Plugin): Record<string, unknown> => ({ ...raw, ...(p.saved ?? {}) });

const FROM = { lastSeenVersion: "1.4.24", pressureSensitivity: true, pressureChoice: true, legacyInkPressure: true };

beforeEach(() => {
	shown.notices.length = 0;
	device.clear();
});

describe("the 1.4.20 pressure toast shows once per device", () => {
	const PRESSURE = "Handwriting: ink too wide? Settings, pen, pressure sensitivity, off.";
	const RAW_1420 = { lastSeenVersion: "1.4.20", pressureSensitivity: true };
	const pressureToasts = (): number => shown.notices.filter((n) => n.message === PRESSURE).length;

	it("at the launch that marks the cohort pending, and not at the next, while the notes still show untapped", async () => {
		const first = await launched(RAW_1420, "1.5.0");
		expect(pressureToasts(), "the launch that marks pending").toBe(1);
		expect(first.settings.lastSeenVersion, "premise: untapped, nothing recorded").toBe("1.4.20");
		shown.notices.length = 0;
		await launched(next(RAW_1420, first), "1.5.0");
		expect(shown.notices.length, "premise: the untapped notes show again").toBe(1);
		expect(pressureToasts(), "the next launch").toBe(0);
	});
});

describe("the 1.5.0 notes stay until tapped", () => {
	it("open with no timeout", async () => {
		await launched(FROM, "1.5.0");
		expect(shown.notices, "premise: one notice").toHaveLength(1);
		expect(shown.notices[0]!.duration).toBe(0);
	});

	it("close on a tap", async () => {
		await launched(FROM, "1.5.0");
		const n = shown.notices[0]!;
		expect(n.taps, "a tap listener").toHaveLength(1);
		n.taps[0]!();
		expect(n.hidden).toBe(1);
	});

	it("a launch with no tap records nothing, and the next launch shows them again", async () => {
		const first = await launched(FROM, "1.5.0");
		expect(first.settings.lastSeenVersion, "not recorded at launch").toBe("1.4.24");
		expect(first.saved?.lastSeenVersion ?? "1.4.24", "nothing on disk says seen").toBe("1.4.24");
		shown.notices.length = 0;
		await launched(next(FROM, first), "1.5.0");
		expect(shown.notices, "shown again").toHaveLength(1);
		expect(shown.notices[0]!.duration).toBe(0);
	});

	it("a tap records the version, and the next launch shows nothing", async () => {
		const first = await launched(FROM, "1.5.0");
		shown.notices[0]!.taps[0]!();
		await settingsWritten(first as unknown as Record<string, unknown>);
		expect(first.settings.lastSeenVersion).toBe("1.5.0");
		expect(first.saved?.lastSeenVersion, "saved").toBe("1.5.0");
		shown.notices.length = 0;
		await launched(next(FROM, first), "1.5.0");
		expect(shown.notices).toHaveLength(0);
	});
});

describe("CONTROL: any other release keeps the timed toast, recorded at launch", () => {
	it("1.5.1 times out as it always has and records the version at launch", async () => {
		const p = await launched({ ...FROM, lastSeenVersion: "1.5.0" }, "1.5.1");
		expect(shown.notices, "premise: one notice").toHaveLength(1);
		expect(shown.notices[0]!.duration).toBe(whatsNewDurationMs(1));
		expect(shown.notices[0]!.taps, "no tap listener").toHaveLength(0);
		expect(p.settings.lastSeenVersion).toBe("1.5.1");
		expect(p.saved?.lastSeenVersion).toBe("1.5.1");
	});
});

/**
 * The real onunload on the same bare plugin. Only what this harness never built is filled in: the timer maps, the PDF
 * store's cancel, the paper (applyPaper walks every leaf of a workspace that is not here) and the detached persistence
 * finish, which settles stores this plugin does not have. The settings write a tap would start is the plugin's own.
 */
function unloaded(plugin: Record<string, unknown>): void {
	const body = (globalThis as unknown as { document: { body: { classList: Record<string, unknown> } } }).document.body;
	body.classList.remove ??= () => {};
	plugin.pendingRecycle = new Map();
	plugin.declaimTimers = new Map();
	plugin.pdfStore = { ...(plugin.pdfStore as object), cancelPendingDeletes: () => {} };
	plugin.applyPaper = (): void => {};
	plugin.finishPersistence = (): Promise<void> => Promise.resolve();
	(HandwritingPlugin.prototype as unknown as { onunload(this: unknown): void }).onunload.call(plugin);
}

describe("the 1.5.0 notes come down with the plugin", () => {
	it("unload puts the untapped notes down, and a tap after unload writes nothing", async () => {
		const p = (await launched(FROM, "1.5.0")) as unknown as Record<string, unknown>;
		const n = shown.notices[0]!;
		expect(n.hidden, "premise: still up before unload").toBe(0);
		unloaded(p);
		expect(n.hidden, "put down at unload").toBe(1);
		let writes = 0;
		p.saveData = (): Promise<void> => {
			writes++;
			return Promise.resolve();
		};
		n.taps[0]!();
		await settingsWritten(p);
		expect(writes, "no settings write after unload").toBe(0);
		expect((p.settings as Record<string, unknown>).lastSeenVersion, "the version is not recorded").toBe("1.4.24");
	});
});
