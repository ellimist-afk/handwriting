/**
 * The iPad Scribble warning's platform, rendering and persistence lifecycle,
 * executed through the real plugin methods. Obsidian itself has no Node
 * runtime, so only the host boundaries are faked: Platform flags, Notice,
 * createFragment, and data.json reads/writes.
 *
 * This proves that the production method gives blockNotice Alan's exact four
 * blocks, gates on Obsidian's iOS+tablet flags, and burns its latch after a
 * Notice exists. It does not render a real Obsidian Notice or identify an
 * actual device; that remains device acceptance.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({
	isDesktopApp: false,
	isMobileApp: true,
	isIosApp: true,
	isAndroidApp: false,
	isTablet: true,
	isPhone: false,
}));

const notices = vi.hoisted(() => ({
	blocks: [] as string[][],
	durations: [] as number[],
	throwOnConstruct: false,
}));

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Platform: platform,
		Notice: class {
			constructor(message: unknown, duration?: number) {
				if (notices.throwOnConstruct) throw new Error("Notice construction refused");
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

const proto = HandwritingPlugin.prototype as unknown as {
	loadSettings(this: unknown): Promise<void>;
	showScribbleHintIfDue(this: unknown): void;
};

const HINT = [
	"IPAD USERS ONLY",
	"if you are seeing black ink 'lift' up off the page and ink is disappearing",
	"turn off scribble > iPad settings > Apple pencil > scribble toggle off",
	"- alan :)",
];

interface FakeFragment {
	blocks: string[];
	createDiv(opts?: { text?: string }): FakeFragment;
}

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
	saved: Record<string, unknown> | null;
	writes: number;
	settingsWriting: Promise<void> | null;
}

function fakePlugin(raw: unknown): Harness {
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.loadData = (): Promise<unknown> => Promise.resolve(raw);
	plugin.saved = null;
	plugin.writes = 0;
	plugin.saveData = (data: Record<string, unknown>): Promise<void> => {
		plugin.writes = (plugin.writes as number) + 1;
		plugin.saved = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
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
	return plugin as unknown as Harness;
}

async function loaded(raw: unknown): Promise<Harness> {
	ensureDocument();
	const plugin = fakePlugin(raw);
	await proto.loadSettings.call(plugin);
	return plugin;
}

async function settled(plugin: Harness): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
		if (plugin.settingsWriting) await plugin.settingsWriting;
		await Promise.resolve();
	}
}

function setPlatform(
	values: Partial<typeof platform> & Pick<typeof platform, "isIosApp" | "isTablet">
): void {
	Object.assign(platform, {
		isDesktopApp: false,
		isMobileApp: true,
		isIosApp: false,
		isAndroidApp: false,
		isTablet: false,
		isPhone: false,
	});
	Object.assign(platform, values);
}

describe("the iPad Scribble warning lifecycle", () => {
	beforeEach(() => {
		installFragment();
		setPlatform({ isIosApp: true, isTablet: true });
		notices.blocks.length = 0;
		notices.durations.length = 0;
		notices.throwOnConstruct = false;
	});

	it("renders Alan's exact copy as four sticky blocks on the iPad signal", async () => {
		const plugin = await loaded({});
		proto.showScribbleHintIfDue.call(plugin);

		expect(notices.blocks).toEqual([HINT]);
		expect(notices.durations).toEqual([0]);
		expect(plugin.settings.scribbleHintOffered).toBe(true);
	});

	it("stays quiet on Paladin, Orion, iPhone, Android, and an e-ink Android tablet", async () => {
		const cases: Array<[string, Partial<typeof platform> & Pick<typeof platform, "isIosApp" | "isTablet">]> = [
			["Paladin Windows desktop", { isIosApp: false, isTablet: false, isDesktopApp: true, isMobileApp: false }],
			["Orion macOS desktop", { isIosApp: false, isTablet: false, isDesktopApp: true, isMobileApp: false }],
			["iPhone", { isIosApp: true, isTablet: false, isPhone: true }],
			["Android phone", { isIosApp: false, isTablet: false, isAndroidApp: true, isPhone: true }],
			["e-ink Android tablet", { isIosApp: false, isTablet: true, isAndroidApp: true }],
		];

		for (const [name, flags] of cases) {
			setPlatform(flags);
			const plugin = await loaded({ booxMode: name.includes("e-ink") });
			proto.showScribbleHintIfDue.call(plugin);
			expect(notices.blocks, name).toEqual([]);
			expect(plugin.settings.scribbleHintOffered, name).toBe(false);
			expect(plugin.writes, name).toBe(0);
		}
	});

	it("fires once, persists the latch, and a restarted vault stays quiet", async () => {
		const plugin = await loaded({ futureKey: 7 });
		proto.showScribbleHintIfDue.call(plugin);
		proto.showScribbleHintIfDue.call(plugin);
		await settled(plugin);

		expect(notices.blocks).toEqual([HINT]);
		expect(plugin.writes).toBe(1);
		expect(plugin.saved?.scribbleHintOffered).toBe(true);
		expect(plugin.saved?.futureKey).toBe(7);

		const restarted = await loaded(plugin.saved);
		proto.showScribbleHintIfDue.call(restarted);
		expect(notices.blocks).toEqual([HINT]);
		expect(restarted.writes).toBe(0);
	});

	it("does not burn or save the latch when the Notice never appears", async () => {
		const plugin = await loaded({});
		notices.throwOnConstruct = true;

		expect(() => proto.showScribbleHintIfDue.call(plugin)).toThrow(
			"Notice construction refused"
		);
		expect(plugin.settings.scribbleHintOffered).toBe(false);
		expect(plugin.writes).toBe(0);
		expect(plugin.saved).toBeNull();
	});

	it("is invoked from the post-layout one-launch notice callback", () => {
		const wiring = "this.showWhatsNewIfDue();\n\t\t\tthis.showScribbleHintIfDue();";
		expect(
			[mainSource, onloadSource].join("\n").replace(/\r\n/g, "\n").split(wiring),
			"the Scribble warning is no longer wired after layout"
		).toHaveLength(2);
	});
});
