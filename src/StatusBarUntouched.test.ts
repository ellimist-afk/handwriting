/**
 * Obsidian's status bar is left alone BY DEFAULT, and hidden only on request.
 *
 * 1.4.19 hid it unconditionally: `body.handwriting-active-page .status-bar`
 * in styles.css, with main.ts stamping that body class whenever the ACTIVE note
 * was a Handwriting page. The bar vanished on every inked note, came back only
 * by disabling the plugin, and survived a restart because the class is
 * re-stamped at layout (Alan, 1.4.19, Windows 11). There was never a leak -
 * `onunload` removed the class correctly the whole time - the behaviour itself
 * was the defect, because the bar also carries word count, backlink and
 * property counts and OTHER plugins' items.
 *
 * The overlap it was written for is real, though: on a Handwriting page the bar
 * does sit over the lower edge of the writing surface and the horizontal
 * scrollbar. So the behaviour stays and the default flips - visible by default,
 * `hideStatusBarOnInkedNotes` for whoever wants the surface clear (Alan's
 * ruling). The file name still reads true of the default, which is the state
 * every vault is in until someone asks otherwise.
 *
 * TWO HALVES, AND NEITHER ONE ALONE IS THE GUARANTEE:
 *
 *   the stylesheet  one rule may hide the bar and it must be gated behind
 *                   `handwriting-active-page`. An ungated `.status-bar` rule -
 *                   or one gated behind some OTHER class - hides the bar no
 *                   matter what the setting says, which is the defect back.
 *   the stamping    `applyStatusBarVisibility` is the only thing that puts that
 *                   class on <body>, and with the setting off it must refuse to,
 *                   and must clear a class already there.
 *
 * The stylesheet half is read through `codeOnly` (src/CodeOnly.ts, the shared
 * stripper GuardStyle.test.ts uses) so the prose above can name the selector
 * without failing the file that documents it. A rule commented out is a rule
 * out of the cascade, so agreeing it is gone is agreeing correctly.
 *
 * `.status-bar-item` is deliberately not flagged: the recording badge
 * (`addStatusBarItem`, main.ts) is the plugin's own item, and styling it is
 * legitimate. Hiding the bar that hosts everyone's is the thing under guard.
 */

import { afterEach, describe, expect, it } from "vitest";
import HandwritingPlugin, { HandwritingSettingTab } from "./main";
import css from "../styles.css?raw";
import mainSrc from "./main.ts?raw";
import { codeOnly } from "./CodeOnly";
import { inlineInk } from "./inline/InkOverlay";

const CLASS = "handwriting-active-page";
const KEY = "hideStatusBarOnInkedNotes";

/** `.status-bar` as the element itself, never `.status-bar-item`. */
const STATUS_BAR = /\.status-bar(?![\w-])/;

/** Every selector list in `src` that targets the status bar container. */
function statusBarSelectors(src: string): string[] {
	const found: string[] = [];
	// A selector list is the run between the previous block boundary and the
	// `{` opening this one. `@media` preludes match here too and simply never
	// contain `.status-bar`; a rule nested in one is its own match.
	for (const m of codeOnly(src).matchAll(/([^{}]*)\{/g)) {
		const selector = (m[1] ?? "").trim().replace(/\s+/g, " ");
		if (STATUS_BAR.test(selector)) found.push(selector);
	}
	return found;
}

// ---- the DOM half ----------------------------------------------------------

type ClassList = {
	seen: Set<string>;
	add(c: string): void;
	remove(...c: string[]): void;
	toggle(c: string, force?: boolean): void;
	contains(c: string): boolean;
};

function fakeClassList(initial: readonly string[] = []): ClassList {
	const seen = new Set<string>(initial);
	return {
		seen,
		add: (c) => void seen.add(c),
		remove: (...cs) => {
			for (const c of cs) seen.delete(c);
		},
		toggle: (c, force) => {
			const on = force ?? !seen.has(c);
			if (on) seen.add(c);
			else seen.delete(c);
		},
		contains: (c) => seen.has(c),
	};
}

const g = globalThis as unknown as { document?: unknown };
const realDocument = g.document;
const realPresence = inlineInk.inkPresence.bind(inlineInk);
const realEnsureLoaded = inlineInk.ensureLoaded.bind(inlineInk);
const realIsPage = inlineInk.isHandwritingPage.bind(inlineInk);

afterEach(() => {
	g.document = realDocument;
	inlineInk.inkPresence = realPresence;
	inlineInk.ensureLoaded = realEnsureLoaded;
	inlineInk.isHandwritingPage = realIsPage;
});

/** Install a body whose classList this test can read back. */
function installBody(initial: readonly string[] = []): ClassList {
	const classList = fakeClassList(initial);
	g.document = { body: { classList } };
	return classList;
}

type Applier = { applyStatusBarVisibility(): void };

function pluginWith(opts: {
	hide: boolean;
	active: { path: string; extension: string } | null;
	inked: boolean | "unknown";
	afterLoad?: "ink" | "none";
}): Applier {
	let presence: "ink" | "none" | "unknown" = opts.inked === true ? "ink" : opts.inked === false ? "none" : "unknown";
	inlineInk.inkPresence = () => presence;
	// Ids are permanent: the inked note keeps its page id whatever its strokes do.
	inlineInk.isHandwritingPage = (p) => p === INKED.path;
	inlineInk.ensureLoaded = () => {
		presence = opts.afterLoad ?? presence;
		return Promise.resolve(true);
	};
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.settings = { [KEY]: opts.hide };
	plugin.app = { workspace: { getActiveFile: () => opts.active } };
	return plugin as unknown as Applier;
}

const INKED = { path: "Notes/drawn.md", extension: "md" };
const PLAIN = { path: "Notes/prose.md", extension: "md" };

describe("the stylesheet can only hide the bar behind the opt-in class", () => {
	it("has exactly the gated rule, and no ungated one", () => {
		const selectors = statusBarSelectors(css);
		// Anti-vacuity FIRST: a scanner that found nothing would pass the
		// gating assertion below while proving the reverse of it.
		expect(selectors.length).toBeGreaterThan(0);
		for (const selector of selectors) expect(selector).toContain(CLASS);
	});

	it("does not flag the plugin's own status bar item", () => {
		expect(statusBarSelectors(".status-bar-item.handwriting-recording { color: red; }")).toEqual(
			[]
		);
	});

	it("catches an ungated rule, and one gated behind some other class", () => {
		expect(statusBarSelectors(".status-bar { display: none; }")).toEqual([".status-bar"]);
		const otherClass = "body.handwriting-page .status-bar { display: none; }";
		expect(statusBarSelectors(otherClass)[0]).not.toContain(CLASS);
	});

	it("reads code, not prose: a commented rule is out of the cascade", () => {
		expect(statusBarSelectors("/* .status-bar { display: none; } */\r\n.x { top: 0; }")).toEqual(
			[]
		);
	});
});

describe("with the setting OFF - the default - nothing is ever stamped", () => {
	it("leaves the bar alone on an inked note", () => {
		const body = installBody();
		pluginWith({ hide: false, active: INKED, inked: true }).applyStatusBarVisibility();
		expect(body.contains(CLASS)).toBe(false);
	});

	it("CLEARS a class already on the body", () => {
		// The half that makes turning the setting off put the bar back NOW
		// rather than at the next leaf change.
		const body = installBody([CLASS]);
		pluginWith({ hide: false, active: INKED, inked: true }).applyStatusBarVisibility();
		expect(body.contains(CLASS)).toBe(false);
	});
});

describe("with the setting ON it behaves as it always did", () => {
	it("hides on an inked note", () => {
		const body = installBody();
		pluginWith({ hide: true, active: INKED, inked: true }).applyStatusBarVisibility();
		expect(body.contains(CLASS)).toBe(true);
	});

	it("does not hide on an ordinary note", () => {
		const body = installBody([CLASS]);
		pluginWith({ hide: true, active: PLAIN, inked: false }).applyStatusBarVisibility();
		expect(body.contains(CLASS)).toBe(false);
	});

	it("does not hide with no file open, or on a non-markdown file", () => {
		const none = installBody([CLASS]);
		pluginWith({ hide: true, active: null, inked: true }).applyStatusBarVisibility();
		expect(none.contains(CLASS)).toBe(false);

		const pdf = installBody([CLASS]);
		pluginWith({
			hide: true,
			active: { path: "a.pdf", extension: "pdf" },
			inked: true,
		}).applyStatusBarVisibility();
		expect(pdf.contains(CLASS)).toBe(false);
	});
});

describe("with the setting ON the bar follows the strokes, not the page id", () => {
	it("a note whose ink was all deleted keeps the bar, though its id stays", () => {
		const body = installBody([CLASS]);
		pluginWith({ hide: true, active: INKED, inked: false }).applyStatusBarVisibility();
		expect(body.contains(CLASS), "an emptied note still hides the status bar").toBe(false);
	});

	it("an id whose sidecar is not read yet leaves the bar as it is, then the read settles it", async () => {
		const body = installBody([CLASS]);
		const plugin = pluginWith({ hide: true, active: INKED, inked: "unknown", afterLoad: "none" }) as unknown as Record<string, unknown>;
		plugin.unloaded = false;
		(plugin as unknown as Applier).applyStatusBarVisibility();
		expect(body.contains(CLASS), "unknown changed the bar before the read landed").toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(body.contains(CLASS), "the read found no strokes and the bar did not come back").toBe(false);
	});

	it("a sidecar that stays unreadable is read once per trigger, not again after every read", async () => {
		// A damaged sidecar: every load resolves and presence stays unknown.
		const body = installBody([CLASS]);
		const plugin = pluginWith({ hide: true, active: INKED, inked: "unknown" }) as unknown as Record<string, unknown>;
		plugin.unloaded = false;
		let reads = 0;
		inlineInk.ensureLoaded = () => {
			reads++;
			return Promise.resolve(false);
		};
		const flush = async () => {
			for (let i = 0; i < 40; i++) await Promise.resolve();
		};
		(plugin as unknown as Applier).applyStatusBarVisibility();
		await flush();
		expect(reads, "one read for the one trigger").toBe(1);
		expect(body.contains(CLASS), "still unknown: the bar is left as it was").toBe(true);
		// The next outside trigger (a leaf change, an ink event) may try once more.
		(plugin as unknown as Applier).applyStatusBarVisibility();
		await flush();
		expect(reads, "one more read for the second trigger").toBe(2);
	});

	it("A to B to A while A's unreadable sidecar loads starts no read beyond the two triggers", async () => {
		// Both A triggers share A's one pending load. When it resolves still
		// unknown, both completions re-evaluate; neither may start another read.
		installBody([CLASS]);
		const A = { path: "Notes/a.md", extension: "md" };
		const B = { path: "Notes/b.md", extension: "md" };
		let active = A;
		const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
		plugin.settings = { [KEY]: true };
		plugin.app = { workspace: { getActiveFile: () => active } };
		plugin.unloaded = false;
		inlineInk.inkPresence = () => "unknown";
		let releaseA: (v: boolean) => void = () => {};
		const pendingA = new Promise<boolean>((resolve) => {
			releaseA = resolve;
		});
		const loads: string[] = [];
		inlineInk.ensureLoaded = (path: string) => {
			loads.push(path);
			return path === A.path ? pendingA : Promise.resolve(false);
		};
		const flush = async () => {
			for (let i = 0; i < 40; i++) await Promise.resolve();
		};
		const applier = plugin as unknown as Applier;
		applier.applyStatusBarVisibility();
		active = B;
		applier.applyStatusBarVisibility();
		active = A;
		applier.applyStatusBarVisibility();
		expect(loads.filter((p) => p === A.path), "A trigger 1 and trigger 3 each attach").toHaveLength(2);
		// B's own read settles first, while A's is still pending: its finally must
		// leave A's marker alone.
		await flush();
		active = A;
		releaseA(false);
		await flush();
		expect(loads.filter((p) => p === A.path), "no third read of A after the shared load settles").toHaveLength(2);
		expect(plugin.statusBarReadFor, "the marker is clear once every read settled").toBeNull();
	});

	it("unknown on a note arriving from an ordinary one does not hide the bar before the read", () => {
		const body = installBody();
		const plugin = pluginWith({ hide: true, active: INKED, inked: "unknown", afterLoad: "ink" }) as unknown as Record<string, unknown>;
		plugin.unloaded = false;
		(plugin as unknown as Applier).applyStatusBarVisibility();
		expect(body.contains(CLASS), "unknown hid the bar before anything was known").toBe(false);
	});

	it("an ink change on the active note re-decides the bar", () => {
		// Delete all ink touches no metadata, so only the ink event can bring the bar back.
		expect(codeOnly(mainSrc)).toMatch(/onInkChanged\(\(p\) => \{\s*if \(p === this\.app\.workspace\.getActiveFile\(\)\?\.path\) updateStatusBarClass\(\);/);
	});
});

describe("the default, and what an existing vault loads", () => {
	const proto = HandwritingPlugin.prototype as unknown as {
		loadSettings(this: unknown): Promise<void>;
	};

	async function loaded(raw: unknown): Promise<Record<string, unknown>> {
		installBody();
		const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
		// Obsidian reads a missing data.json as null; undefined means it could not be read.
		plugin.loadData = (): Promise<unknown> => Promise.resolve(raw === undefined ? null : raw);
		plugin.saveData = (): Promise<void> => Promise.resolve();
		plugin.settingsTimer = null;
		plugin.settingsDirty = false;
		plugin.settingsWriting = null;
		plugin.settingsWriteAgain = false;
		plugin.store = { useInkFolder: () => {}, load: () => null, schedule: () => {} };
		plugin.pdfStore = { attachHost: () => {} };
		plugin.app = {
			workspace: { onLayoutReady: () => {} },
			vault: { adapter: { exists: async () => false, list: async () => ({ files: [], folders: [] }) } },
		};
		plugin.applyPaperTo = (): void => {};
		plugin.applyBooxMode = (): void => {};
		plugin.manifest = { version: "1.4.20" };
		await proto.loadSettings.call(plugin);
		return plugin.settings as Record<string, unknown>;
	}

	it("a vault that has never heard of the key loads OFF", async () => {
		// EVERY vault that ran 1.4.19 is this one. `!== false` here instead of
		// `=== true` would read absence as ON and re-ship the defect to exactly
		// the users who reported it.
		expect((await loaded({}))[KEY]).toBe(false);
		expect((await loaded(undefined))[KEY]).toBe(false);
		expect((await loaded({ inkSmoothing: true }))[KEY]).toBe(false);
	});

	it("a vault that asked for it loads ON", async () => {
		expect((await loaded({ [KEY]: true }))[KEY]).toBe(true);
	});
});

describe("the settings tab drives it live", () => {
	it("offers the row", () => {
		const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
		plugin.manifest = { version: "1.4.20" };
		plugin.settings = { [KEY]: false };
		// `getSettingDefinitions` asks the app whether gated commands can be
		// removed, which is a different row's concern and not this one's.
		plugin.app = { commands: { removeCommand: () => {} } };
		const tab = Object.create(HandwritingSettingTab.prototype) as {
			plugin: unknown;
			getSettingDefinitions(): Row[];
		};
		tab.plugin = plugin;
		type Row = { items?: Row[]; control?: { type: string; key: string } };
		const flatten = (rows: Row[]): Row[] =>
			rows.flatMap((r) => (r.items ? flatten(r.items) : [r]));
		const keys = flatten(tab.getSettingDefinitions()).map((r) => r.control?.key);
		expect(keys).toContain(KEY);
	});

	it("applies both directions without waiting for a leaf change", () => {
		const body = installBody();
		const plugin = pluginWith({
			hide: false,
			active: INKED,
			inked: true,
		}) as unknown as Record<string, unknown>;
		plugin.saveSettingsNow = (): void => {};
		const tab = Object.create(HandwritingSettingTab.prototype) as {
			plugin: unknown;
			setControlValue(key: string, value: unknown): void;
		};
		tab.plugin = plugin;

		tab.setControlValue(KEY, true);
		expect(body.contains(CLASS)).toBe(true);
		tab.setControlValue(KEY, false);
		expect(body.contains(CLASS)).toBe(false);
	});
});

describe("teardown hands the bar back whatever the setting says", () => {
	it("onunload removes the class unconditionally", () => {
		// Read as code so a sentence about the removal cannot stand in for it.
		// Gating this line on the setting would strand the bar hidden for
		// exactly the users who had turned the option on.
		expect(codeOnly(mainSrc)).toContain(`document.body.classList.remove("${CLASS}")`);
	});
});
