/**
 * THE ONE-TIME NOTICE FOR VAULTS UPGRADING OUT OF 1.4.20.
 *
 * 1.4.20 removed the Pressure sensitivity row and pinned the setting on, and
 * saved strokes are shaped at render time, so a vault that had chosen pressure
 * off redrew its old ink under the pressure law. 1.4.21 honours the stored
 * value again and gives the row back, but 1.4.20 had already rewritten a stored
 * `false` to `true` on its next save: those vaults load ON and have to switch
 * the row off once by hand. Nothing in data.json separates them from the vaults
 * that chose pressure on, so the notice goes to all of them and changes nothing.
 *
 * The three arms below are the whole contract: the version that can have been
 * caught and is still on (notice), any other version (silence), and the version
 * that can have been caught but is already off (silence).
 *
 * The what's-new toast is exercised beside the notice, not stubbed away. The
 * first version of this cell was green only because 1.4.21 had no RELEASE_NOTES
 * entry yet, so that toast never ran: the moment the version bump added one, the
 * real `whatsNewFragment` called Obsidian's `createFragment`, which does not
 * exist in this environment, and the notice was never reached. Three arms went
 * red in the package gate. The fake fragment below is what lets
 * the due-toast path run here, and the last arm holds that path open.
 *
 * WHAT THIS CANNOT PROVE. The `obsidian` package ships no runtime, so the real
 * `Notice` never runs here; the fake below records what the plugin asked the
 * screen to show, in order, with the duration it asked for. Nothing here
 * touches a vault, and `saveData` is asserted on rather than mocked away, so a
 * notice path that quietly wrote to disk would be caught.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => ({ messages: [] as unknown[], durations: [] as number[] }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			constructor(message: unknown, duration?: number) {
				notices.messages.push(message);
				notices.durations.push(duration ?? -1);
			}
		},
	};
});

/**
 * The release-notes table main.ts reads is the module's own, so a test cannot
 * hand it one. `decideWhatsNew` already takes the table as its last argument
 * for exactly this reason; the wrapper below passes the override through when
 * one is set and is the real function otherwise. Nothing else is faked: the
 * decision, the fragment and the notice all run.
 */
const override = vi.hoisted(() => ({ notes: null as Record<string, string[]> | null }));
vi.mock("./update/WhatsNew", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	const real = actual.decideWhatsNew as (...args: unknown[]) => unknown;
	return {
		...actual,
		decideWhatsNew: (current: unknown, seen: unknown, fresh: unknown, notes?: unknown) =>
			real(current, seen, fresh, notes ?? override.notes ?? undefined),
	};
});

import HandwritingPlugin from "./main";
import { RELEASE_NOTES } from "./update/WhatsNew";

/** Run one launch with a release-notes table the module does not carry yet. */
function withNotes(notes: Record<string, string[]>, run: () => void): void {
	override.notes = notes;
	try {
		run();
	} finally {
		override.notes = null;
	}
}

/**
 * Obsidian injects `createFragment`, and `.createDiv`/`.createEl` on what it
 * returns. This suite runs with no DOM, so a fake with the same call shape
 * stands in and the real `whatsNewFragment` runs unmodified. Same shape as the
 * fake in WhatsNew.test.ts, which pins that function's output node for node.
 */
class FakeEl {
	children: FakeEl[] = [];
	constructor(
		public tag: string,
		public cls?: string,
		public text?: string
	) {}
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

/**
 * The version this rig lands on, and the table as the version bump will leave
 * it: today's entries plus one keyed to that same version. The key has to be
 * the landing version - a table with any other key leaves the what's-new toast
 * with nothing to say, which is how the first version of this cell was green.
 */
const LANDING = "1.4.21";
const NOTES_WITH_LANDING: Record<string, string[]> = {
	...RELEASE_NOTES,
	[LANDING]: ["Ink hotfix"],
};

/** Alan's copy, re-cased to sentence case for the checker's rule; the wording is unchanged. Do not paraphrase. */
const PRESSURE_NOTICE = "Handwriting: ink too wide? Settings, pen, pressure sensitivity, off.";

const proto = HandwritingPlugin.prototype as unknown as {
	loadSettings(this: unknown): Promise<void>;
	showWhatsNewIfDue(this: unknown): void;
};

type Plugin = {
	settings: Record<string, unknown>;
	saved: Record<string, unknown> | null;
	saveCount: number;
};

function ensureDocument(): void {
	const g = globalThis as unknown as { document?: unknown };
	g.document ??= {
		body: { classList: { add: () => {}, toggle: () => {}, contains: () => false } },
	};
}

/**
 * The plugin as the launch path meets it: the settings main.ts built from this
 * vault's data.json, the manifest version it is landing on, and the two
 * boundaries that matter - the disk and the screen.
 */
async function launched(
	raw: unknown,
	version = "1.4.21",
	notes?: Record<string, string[]>
): Promise<Plugin> {
	ensureDocument();
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.loadData = (): Promise<unknown> => Promise.resolve(raw);
	plugin.saved = null;
	plugin.saveCount = 0;
	plugin.saveData = (data: Record<string, unknown>): Promise<void> => {
		plugin.saved = { ...data };
		plugin.saveCount = (plugin.saveCount as number) + 1;
		return Promise.resolve();
	};
	// The rest of what `loadSettings` reaches for on the way past. Faked, not
	// exercised: this cell is about one branch at the end of the launch path.
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
	if (notes) {
		withNotes(notes, () => proto.showWhatsNewIfDue.call(plugin));
	} else {
		proto.showWhatsNewIfDue.call(plugin);
	}
	return plugin as unknown as Plugin;
}

const pressureNotices = (): unknown[] => notices.messages.filter((m) => m === PRESSURE_NOTICE);

describe("the one-time notice for vaults arriving from 1.4.20", () => {
	beforeEach(() => {
		notices.messages.length = 0;
		notices.durations.length = 0;
	});

	it("shows once, for 20 seconds, when the vault comes from 1.4.20 with pressure on", async () => {
		await launched({ lastSeenVersion: "1.4.20", pressureSensitivity: true });
		expect(pressureNotices()).toHaveLength(1);
		const at = notices.messages.indexOf(PRESSURE_NOTICE);
		expect(notices.durations[at]).toBe(20000);
	});

	it("says nothing to a vault arriving from any other version", async () => {
		for (const lastSeenVersion of ["1.4.19", "1.4.18", "1.3.20", "1.4.21"]) {
			notices.messages.length = 0;
			await launched({ lastSeenVersion, pressureSensitivity: true });
			expect(pressureNotices(), lastSeenVersion).toHaveLength(0);
		}
	});

	it("says nothing to a vault from 1.4.20 that is already drawing with pressure off", async () => {
		await launched({ lastSeenVersion: "1.4.20", pressureSensitivity: false });
		expect(pressureNotices()).toHaveLength(0);
	});

	it("changes nothing about the setting, and writes back the same value it read", async () => {
		const plugin = await launched({ lastSeenVersion: "1.4.20", pressureSensitivity: true });
		expect(plugin.settings.pressureSensitivity).toBe(true);
		// The launch path does write, to record the version whose notes it
		// showed. Named here rather than allowed: a null `saved` would make
		// the assertion below pass without the write ever happening.
		expect(plugin.saved, "the launch path wrote data.json").not.toBeNull();
		expect(plugin.saved?.pressureSensitivity).toBe(true);
	});

	it("still shows when the what's-new toast is due as well", async () => {
		const plugin = await launched(
			{ lastSeenVersion: "1.4.20", pressureSensitivity: true },
			LANDING,
			NOTES_WITH_LANDING
		);
		// The what's-new toast is DUE, named rather than counted. The entry is
		// keyed to the landing version, and if it were keyed to anything else
		// this toast would not be built at all - which is the exact way the
		// first version of this cell passed while proving nothing.
		const title = notices.messages.find(
			(m): m is FakeEl => m instanceof FakeEl
		);
		expect(title, "the what's-new toast was built").toBeDefined();
		expect(title?.children[0]?.text, "its title names the landing version").toBe(
			`Handwriting ${LANDING}`
		);
		expect(notices.messages.length, "two toasts on this launch").toBe(2);
		expect(pressureNotices()).toHaveLength(1);
		expect(plugin.saved?.lastSeenVersion, "the version still moved on").toBe(LANDING);
	});

	// The reason the notice moved above the what's-new block. That
	// block swallows its own failure and returns early, on purpose, so anything
	// after it is skipped on that path - and this notice is the point of the
	// release it ships in. Faking the failure is the only way to hold that open:
	// with the notice below the block, this arm is red.
	it("shows even when the what's-new toast fails to open", async () => {
		const good = (globalThis as unknown as { createFragment: unknown }).createFragment;
		(globalThis as unknown as { createFragment: unknown }).createFragment = (): never => {
			throw new Error("no fragments in this environment");
		};
		try {
			const plugin = await launched(
				{ lastSeenVersion: "1.4.20", pressureSensitivity: true },
				"1.4.21",
				NOTES_WITH_LANDING
			);
			expect(pressureNotices(), "the pressure notice survived").toHaveLength(1);
			// The what's-new block still leaves the version unrecorded so its own
			// notes retry next launch. That is its contract, not ours to change.
			expect(plugin.saved, "no record written on that path").toBeNull();
		} finally {
			(globalThis as unknown as { createFragment: unknown }).createFragment = good;
		}
	});

	it("is one launch only: the second launch reads the version the first recorded", async () => {
		const first = await launched({ lastSeenVersion: "1.4.20", pressureSensitivity: true });
		expect(pressureNotices()).toHaveLength(1);
		expect(first.saved, "the first launch wrote data.json").not.toBeNull();
		expect(first.saved?.lastSeenVersion, "the version moved on").toBe("1.4.21");
		notices.messages.length = 0;
		// What the first launch left on disk is what the second one loads.
		await launched({ ...(first.saved ?? {}) });
		expect(pressureNotices(), "second launch").toHaveLength(0);
	});
});
