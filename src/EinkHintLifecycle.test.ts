/**
 * The e-ink hint's LIFECYCLE, executed rather than read.
 *
 * `EinkHint.test.ts` drives the decision and `LatencyEstimate.test.ts` drives
 * the evidence. Neither says anything about the parts a user actually feels:
 * that being told once survives a restart, that a failed write is not mistaken
 * for a durable one, that a rotten value in data.json cannot silence the hint
 * forever, and that the poll stops when the plugin does. d3b8bdb shipped with
 * none of that, and a green suite of 3,672 tests said nothing about it.
 *
 * HOW IT DRIVES THE REAL METHODS. `checkEinkHint`, `applyBooxMode`,
 * `saveSettingsNow`, `persistSettings` and `loadSettings` are the code under
 * test and NONE of them is stubbed. Following the pattern
 * `SettingsUnknownKeys.test.ts` established: `Object.create(
 * HandwritingPlugin.prototype)` for an instance with no field initialisers,
 * the few members those methods touch supplied by hand, and only the OBSIDIAN
 * boundary faked - `loadData`/`saveData` (the disk) and `Notice` (the screen).
 * The samples are real: every batch below goes through `recordPresentAge`, the
 * same call the render loop makes.
 *
 * WHAT IT CANNOT PROVE, stated so nobody reads more into it. The `obsidian`
 * package ships no runtime, so `Plugin.registerInterval`'s real implementation
 * is not executed anywhere in this suite - the polling case below drives the
 * registration's ACTUAL source text against a host adapter that keeps
 * Obsidian's documented contract (a registered interval is cleared when the
 * component unloads). That is host-adapter coverage, not a live Obsidian run.
 * Nothing here touches a vault or a device.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => ({ blocks: [] as string[][], durations: [] as number[] }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			constructor(message: unknown, duration?: number) {
				// Alan's notice is a fragment of three divs, not a string; the
				// fake fragment below collects their text in order.
				const frag = message as { blocks?: string[] };
				notices.blocks.push(
					typeof message === "string" ? [message] : [...(frag.blocks ?? [])]
				);
				notices.durations.push(duration ?? -1);
			}
		},
	};
});

import HandwritingPlugin from "./main";
import mainSource from "./main.ts?raw";
// The onload phases live in PluginOnload.ts, read here with main.ts.
import onloadSource from "./PluginOnload.ts?raw";
import { recordPresentAge, resetLatencyEstimate } from "./ink/LatencyEstimate";
import { resetEinkHint } from "./ink/EinkHint";

const proto = HandwritingPlugin.prototype as unknown as {
	loadSettings(this: unknown): Promise<void>;
	persistSettings(this: unknown): Promise<void>;
	saveSettingsNow(this: unknown): void;
	checkEinkHint(this: unknown): void;
	applyBooxMode(this: unknown): void;
};

/**
 * Alan's copy, verbatim (1.4.13, landed in 5b3bc7d). Three blocks, in this
 * order, lowercase but for the leading condition, and his sign-off. The
 * condition leads on purpose: the gate is measured SLOWNESS, not e-ink
 * hardware, so anyone it does not apply to can stop at the first line.
 * Do not paraphrase, sentence-case, or prefix "Handwriting:".
 */
const HINT = [
	"IF YOU ARE ON BOOX",
	"try the boox toggle in handwriting settings",
	"-alan :)",
];

/** Sticky, on Alan's ruling: it stays until dismissed. */
const STICKY = 0;

/**
 * `loadSettings` and the real `applyBooxMode` both reach for the document, and
 * this suite runs in node. False for `contains` is the honest answer for a run
 * with no theme class on the body.
 */
interface FakeFragment {
	blocks: string[];
	createDiv(opts?: { text?: string }): FakeFragment;
}

/**
 * `createFragment` and `.createDiv` are Obsidian-injected globals that exist
 * only inside a real Obsidian window; this suite runs with no DOM. The fake
 * has the same call shape, so `checkEinkHint` runs completely unmodified and
 * its notice can be read back block by block.
 */
function installFragment(): void {
	(globalThis as unknown as { createFragment: unknown }).createFragment = (
		build?: (f: FakeFragment) => void
	): FakeFragment => {
		const frag: FakeFragment = {
			blocks: [],
			createDiv(opts: { text?: string } = {}) {
				frag.blocks.push(opts.text ?? "");
				return frag;
			},
		};
		build?.(frag);
		return frag;
	};
}

function ensureDocument(): void {
	const g = globalThis as unknown as { document?: unknown };
	g.document ??= {
		body: { classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false } },
	};
}

interface Harness {
	settings: Record<string, unknown>;
	/** The last bytes `saveData` accepted, i.e. what data.json would hold. */
	saved: Record<string, unknown> | null;
	writes: number;
	writeFailures: number;
	settingsWriting: Promise<void> | null;
}

function fakePlugin(raw: unknown, failWrite = false): Harness {
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.loadData = (): Promise<unknown> => Promise.resolve(raw);
	plugin.saved = null;
	plugin.writes = 0;
	plugin.writeFailures = 0;
	plugin.saveData = (data: Record<string, unknown>): Promise<void> => {
		plugin.writes = (plugin.writes as number) + 1;
		if (failWrite) {
			plugin.writeFailures = (plugin.writeFailures as number) + 1;
			return Promise.reject(new Error("data.json write refused"));
		}
		// Serialised on the way in, so the stored snapshot is a SEPARATE object
		// from the live settings: asserting on it cannot accidentally read the
		// in-memory value the test just changed.
		plugin.saved = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
		return Promise.resolve();
	};
	// persistSettings' own fields; Object.create skips the initialisers.
	plugin.settingsTimer = null;
	plugin.settingsDirty = false;
	plugin.settingsWriting = null;
	plugin.settingsWriteAgain = false;
	// The seams loadSettings fills in passing.
	plugin.store = { useInkFolder: () => {}, load: () => null, schedule: () => {} };
	plugin.pdfStore = { attachHost: () => {} };
	plugin.app = { workspace: { onLayoutReady: () => {} } };
	plugin.applyPaperTo = (): void => {};
	// applyBooxMode is deliberately NOT shadowed: its transition reset is under test.
	return plugin as unknown as Harness;
}

async function loaded(raw: unknown, failWrite = false): Promise<Harness> {
	ensureDocument();
	const plugin = fakePlugin(raw, failWrite);
	await proto.loadSettings.call(plugin);
	return plugin;
}

/** One interval's worth of real samples, then the real ten-second check. */
function interval(plugin: Harness, ms: number, count: number): void {
	for (let i = 0; i < count; i++) recordPresentAge(ms);
	proto.checkEinkHint.call(plugin);
}

/** Three qualifying intervals: the shortest path to an offer. */
function qualify(plugin: Harness): void {
	interval(plugin, 50, 24);
	interval(plugin, 50, 24);
	interval(plugin, 50, 24);
}

/** Wait out the detached write `saveSettingsNow` starts. */
async function settled(plugin: Harness): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
		if (plugin.settingsWriting) await plugin.settingsWriting.catch(() => {});
		await Promise.resolve();
	}
}

describe("the e-ink hint's lifecycle", () => {
	beforeEach(() => {
		installFragment();
		notices.blocks.length = 0;
		notices.durations.length = 0;
		resetLatencyEstimate();
		resetEinkHint();
	});

	it("writes the latch through the real save path and a restart stays quiet", async () => {
		const plugin = await loaded({});
		qualify(plugin);

		expect(notices.blocks).toEqual([HINT]);
		// Sticky, not a timed toast: a one-launch message missed once is
		// gone for the life of the vault.
		expect(notices.durations).toEqual([STICKY]);
		expect(plugin.settings.einkHintOffered).toBe(true);
		await settled(plugin);
		// Durable, not just in memory: this is the object saveData accepted.
		expect(plugin.saved?.einkHintOffered).toBe(true);

		// A restart: fresh plugin, fresh module state, loading the bytes the
		// first run actually wrote.
		resetLatencyEstimate();
		resetEinkHint();
		const restarted = await loaded(plugin.saved);
		expect(restarted.settings.einkHintOffered).toBe(true);
		qualify(restarted);
		qualify(restarted);
		expect(notices.blocks).toEqual([HINT]);
	});

	it("leaves unrelated settings intact through that same round trip", async () => {
		const plugin = await loaded({ mouseInk: true, futureKey: 7 });
		qualify(plugin);
		await settled(plugin);

		expect(plugin.saved?.mouseInk).toBe(true);
		expect(plugin.saved?.futureKey).toBe(7);
	});

	it("only a boolean true silences the hint; junk in data.json does not", async () => {
		for (const bad of [undefined, null, "true", 1, 0, "yes", {}]) {
			resetLatencyEstimate();
			resetEinkHint();
			notices.blocks.length = 0;
			const plugin = await loaded({ einkHintOffered: bad });
			expect(plugin.settings.einkHintOffered, `raw ${JSON.stringify(bad)}`).toBe(false);
			qualify(plugin);
			expect(notices.blocks, `raw ${JSON.stringify(bad)}`).toEqual([HINT]);
		}

		resetLatencyEstimate();
		resetEinkHint();
		notices.blocks.length = 0;
		const quiet = await loaded({ einkHintOffered: true });
		expect(quiet.settings.einkHintOffered).toBe(true);
		qualify(quiet);
		expect(notices.blocks).toEqual([]);
	});

	it("a failed write is not treated as a durable one", async () => {
		const plugin = await loaded({}, true);
		qualify(plugin);
		await settled(plugin);

		// The notice was shown and the in-memory flag is set - that is what
		// stops a second notice THIS session.
		expect(notices.blocks).toEqual([HINT]);
		expect(plugin.settings.einkHintOffered).toBe(true);
		// But nothing was stored, and the failure was seen by the write path.
		expect(plugin.writeFailures).toBeGreaterThan(0);
		expect(plugin.saved).toBeNull();

		// Rebuilt from the last snapshot that actually landed - there is none,
		// so the next session has no latch and may offer again. The point is
		// that the durable state is honest about what was written, not that
		// re-offering is desirable.
		resetLatencyEstimate();
		resetEinkHint();
		notices.blocks.length = 0;
		const next = await loaded(plugin.saved ?? {});
		expect(next.settings.einkHintOffered).toBe(false);
	});

	it("dismissing the notice does not reopen the latch", async () => {
		const plugin = await loaded({});
		qualify(plugin);
		expect(notices.blocks).toEqual([HINT]);

		// Dismissal is the user's side of a Notice and leaves no callback into
		// the plugin: the latch is what must survive it. Drop the captured
		// message and keep polling.
		notices.blocks.length = 0;
		qualify(plugin);
		qualify(plugin);
		expect(notices.blocks).toEqual([]);
	});

	it("stays quiet on a loaded latch with Boox mode both off and on", async () => {
		const off = await loaded({ einkHintOffered: true, booxMode: false });
		qualify(off);
		expect(notices.blocks).toEqual([]);

		resetLatencyEstimate();
		resetEinkHint();
		const on = await loaded({ einkHintOffered: true, booxMode: true });
		qualify(on);
		expect(notices.blocks).toEqual([]);
	});

	it("a real Boox toggle between ticks throws away progress AND pending samples", async () => {
		const plugin = await loaded({});
		// Two qualifying intervals, then the user toggles on and off with no
		// tick in between - the exact shape the acceptance review measured.
		interval(plugin, 50, 24);
		interval(plugin, 50, 24);
		plugin.settings.booxMode = true;
		proto.applyBooxMode.call(plugin);
		plugin.settings.booxMode = false;
		proto.applyBooxMode.call(plugin);

		// A third qualifying interval must NOT complete the old run.
		interval(plugin, 50, 24);
		expect(notices.blocks).toEqual([]);
		// It takes three fresh ones after the change.
		interval(plugin, 50, 24);
		expect(notices.blocks).toEqual([]);
		interval(plugin, 50, 24);
		expect(notices.blocks).toEqual([HINT]);
	});

	it("samples collected across a toggle are discarded, not carried", async () => {
		const plugin = await loaded({});
		// Pending but insufficient, then a toggle, then a trickle: the old
		// build let these add up to an eligible batch.
		for (let i = 0; i < 23; i++) recordPresentAge(50);
		plugin.settings.booxMode = true;
		proto.applyBooxMode.call(plugin);
		plugin.settings.booxMode = false;
		proto.applyBooxMode.call(plugin);

		interval(plugin, 50, 1);
		interval(plugin, 50, 24);
		interval(plugin, 50, 24);
		expect(notices.blocks).toEqual([]);
	});

	it("reapplying the same disabled mode does not erase a valid partial run", async () => {
		const plugin = await loaded({});
		interval(plugin, 50, 24);
		interval(plugin, 50, 24);
		// The settings tab calls applyBooxMode for its neighbouring toggles;
		// the mode has not changed, so the run must survive.
		proto.applyBooxMode.call(plugin);
		proto.applyBooxMode.call(plugin);
		interval(plugin, 50, 24);
		expect(notices.blocks).toEqual([HINT]);
	});

	it("control 1: a fresh LOW third batch stops the run, though the rolling median is still high", async () => {
		const plugin = await loaded({});
		// The rejected build read a rolling median here. After two high
		// intervals the ring still holds 40 high samples against 24 fresh low
		// ones, so its median stayed 50 and the hint fired on evidence the
		// third interval flatly contradicts.
		interval(plugin, 50, 24);
		interval(plugin, 50, 24);
		interval(plugin, 10, 24);
		expect(notices.blocks).toEqual([]);

		// And it takes three fresh HIGH intervals afterwards, not one.
		interval(plugin, 50, 24);
		expect(notices.blocks).toEqual([]);
		interval(plugin, 50, 24);
		expect(notices.blocks).toEqual([]);
		interval(plugin, 50, 24);
		expect(notices.blocks).toEqual([HINT]);
	});

	it("control 2: insufficient intervals are spent, not banked", async () => {
		const plugin = await loaded({});
		// 23 then 1 cannot add up to an eligible 24: the 23 were spent by the
		// check that saw them. Only the last two intervals qualify, which is
		// two - one short.
		interval(plugin, 50, 23);
		interval(plugin, 50, 1);
		interval(plugin, 50, 24);
		interval(plugin, 50, 24);
		expect(notices.blocks).toEqual([]);

		// One more full interval is the third qualifying one.
		interval(plugin, 50, 24);
		expect(notices.blocks).toEqual([HINT]);
	});

	it("polls through the real registration and stops when the host unloads", async () => {
		// The registration's ACTUAL source text. Fails closed: if the line is
		// reworded or moved, this case stops pretending to cover it.
		const REGISTRATION =
			"this.registerInterval(window.setInterval(() => this.checkEinkHint(), 10_000));";
		expect(
			[mainSource, onloadSource].join("\n").replace(/\r\n/g, "\n").split(REGISTRATION),
			"the registration this case executes is no longer in main.ts"
		).toHaveLength(2);

		const plugin = await loaded({});
		const timers = new Map<number, () => void>();
		let nextHandle = 1;
		const registered: number[] = [];
		const fakeWindow = {
			setInterval(fn: () => void): number {
				const id = nextHandle++;
				timers.set(id, fn);
				return id;
			},
			clearInterval(id: number): void {
				timers.delete(id);
			},
		};
		// Obsidian's Component contract: a registered interval is cleared for
		// you when the component unloads. The adapter keeps that contract.
		const host = plugin as unknown as Record<string, unknown>;
		host.registerInterval = (id: number): number => {
			registered.push(id);
			return id;
		};
		const unload = (): void => {
			for (const id of registered) fakeWindow.clearInterval(id);
			registered.length = 0;
		};

		const run = new Function("window", `return function () { ${REGISTRATION} };`)(
			fakeWindow
		) as (this: unknown) => void;
		run.call(plugin);
		expect(registered).toHaveLength(1);
		expect(timers.size).toBe(1);

		const tick = (): void => {
			for (const fn of [...timers.values()]) fn();
		};

		// Before unload the callback reaches the real checkEinkHint.
		for (let i = 0; i < 24 * 3; i++) recordPresentAge(50);
		tick();
		for (let i = 0; i < 24; i++) recordPresentAge(50);
		tick();
		for (let i = 0; i < 24; i++) recordPresentAge(50);
		tick();
		expect(notices.blocks).toEqual([HINT]);

		// After unload nothing fires again, whatever the samples say.
		unload();
		expect(timers.size).toBe(0);
		notices.blocks.length = 0;
		resetEinkHint();
		const writesBefore = plugin.writes;
		for (let i = 0; i < 24 * 4; i++) recordPresentAge(50);
		tick();
		tick();
		tick();
		tick();
		expect(notices.blocks).toEqual([]);
		expect(plugin.writes).toBe(writesBefore);
	});
});
