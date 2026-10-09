/**
 * THE THREE SETTINGS-SIDE CHANGES OF THE INFINITE CANVAS SETTINGS WORK.
 *
 *   Infinite Canvas   the row's description says what turning it on turns on.
 *   Zoom bar          the row is always live, canvas on or off. The zoom bar
 *                     shows per note, and a note can have the canvas on while
 *                     the global flag is off, so the row must stay usable to
 *                     turn the bar off. The 1.12 painter still honours a
 *                     `disabled` dropdown; that is pinned on a synthetic row.
 *   The canvas toggle re-renders the tab, so a row the canvas decides is redrawn
 *                     the moment the canvas is switched, not at the next open.
 *
 * Harness as SettingsSimplified.test.ts: `Object.create` on the real plugin and
 * tab, the settings object main.ts builds, nothing about the rows restated here.
 */

import { describe, expect, it, vi } from "vitest";
const rec = vi.hoisted(() => ({ disabled: [] as string[] }));

// The obsidian stub's `Setting` does no work on purpose - "a test that needs
// real behaviour should mock the specific thing it needs" - so the painter's
// Setting is replaced here, for this file only, with one that records what the
// painter asks of a row's control.
vi.mock("obsidian", async () => {
	const actual = (await vi.importActual("obsidian")) as Record<string, unknown>;
	class RecordingSetting {
		private name = "";
		setName(n: string): this { this.name = n; return this; }
		setDesc(): this { return this; }
		addToggle(cb: (t: unknown) => void): this {
			const t = { setValue: () => t, onChange: () => t, setDisabled: (v: boolean) => (v && rec.disabled.push(this.name), t) };
			cb(t);
			return this;
		}
		addDropdown(cb: (d: unknown) => void): this {
			const d = { addOption: () => d, setValue: () => d, onChange: () => d, setDisabled: (v: boolean) => (v && rec.disabled.push(this.name), d) };
			cb(d);
			return this;
		}
		addButton(): this { return this; }
		setHeading(): this { return this; }
	}
	return { ...actual, Setting: RecordingSetting };
});

import HandwritingPlugin, { HandwritingSettingTab } from "./main";

const proto = HandwritingPlugin.prototype as unknown as { loadSettings(this: unknown): Promise<void> };

function ensureDocument(): void {
	const g = globalThis as unknown as { document?: unknown };
	g.document ??= {
		body: { classList: { add: () => {}, toggle: () => {}, contains: () => false } },
	};
}

type Plugin = { settings: Record<string, unknown> };

function fakePlugin(raw: unknown): Plugin {
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.loadData = (): Promise<unknown> => Promise.resolve(raw);
	plugin.saveData = (): Promise<void> => Promise.resolve();
	plugin.settingsTimer = null;
	plugin.settingsDirty = false;
	plugin.settingsWriting = null;
	plugin.settingsWriteAgain = false;
	plugin.store = { useInkFolder: () => {}, load: () => null, schedule: () => {} };
	plugin.pdfStore = { attachHost: () => {} };
	plugin.app = { workspace: { onLayoutReady: () => {} } };
	plugin.applyPaperTo = (): void => {};
	plugin.applyBooxMode = (): void => {};
	plugin.manifest = { version: "1.4.20" };
	return plugin as unknown as Plugin;
}

type Row = {
	type?: string;
	name?: string;
	desc?: string;
	items?: Row[];
	control?: { type: string; key: string; disabled?: boolean | (() => boolean); options?: Record<string, string> };
};

interface Tab {
	plugin: Plugin;
	getSettingDefinitions(): Row[];
	setControlValue(key: string, value: unknown): void;
}

async function tabFor(raw: unknown): Promise<Tab> {
	ensureDocument();
	const plugin = fakePlugin(raw);
	await proto.loadSettings.call(plugin);
	const tab = Object.create(HandwritingSettingTab.prototype) as Tab;
	tab.plugin = plugin;
	(plugin as unknown as Record<string, unknown>).saveSettingsNow = (): void => {};
	return tab;
}

const flatten = (rows: Row[]): Row[] => rows.flatMap((r) => (r.items ? flatten(r.items) : [r]));

function row(tab: Tab, name: string): Row {
	const found = flatten(tab.getSettingDefinitions()).find((r) => r.name === name);
	expect(found, `the ${name} row exists`).toBeDefined();
	return found as Row;
}

const isOff = (r: Row): boolean => {
	const d = r.control?.disabled;
	return typeof d === "function" ? d() : d === true;
};

describe("the Infinite Canvas row says what it turns on", () => {
	it("carries the Infinite Canvas description, word for word", async () => {
		const tab = await tabFor({});
		expect(row(tab, "Infinite canvas").desc).toBe("Let the page grow as you write and scroll. Also turns on the zoom bar. Global setting. A note can override it with handwriting-canvas: true or false in its frontmatter. Default off.");
	});
});

describe("the Zoom bar row is live whether the canvas is on or off", () => {
	it("says what it needs", async () => {
		const tab = await tabFor({});
		expect(row(tab, "Zoom bar").desc).toContain("Needs Infinite canvas on for the note.");
	});

	it("is live with the canvas off", async () => {
		const off = await tabFor({ extendCanvasWhileScrolling: false });
		expect(isOff(row(off, "Zoom bar")), "canvas off: the row stays usable to hide the bar").toBe(false);
	});

	it("is live with the canvas on", async () => {
		const on = await tabFor({ extendCanvasWhileScrolling: true });
		expect(isOff(row(on, "Zoom bar")), "canvas on: the row is live").toBe(false);
	});

	/**
	 * The same tab object, not a fresh load, flipped both ways: the row stays live
	 * after every toggle, so no value the canvas takes can grey it.
	 */
	it("stays live on the tab that is already open after the canvas toggle flips either way", async () => {
		const tab = await tabFor({ extendCanvasWhileScrolling: false });
		// The redraw is not under test here; this cell is about the predicate.
		(tab as unknown as Record<string, unknown>).update = (): void => {};
		expect(isOff(row(tab, "Zoom bar"))).toBe(false);
		tab.setControlValue("extendCanvasWhileScrolling", true);
		expect(isOff(row(tab, "Zoom bar")), "the canvas went on under the open tab").toBe(false);
		tab.setControlValue("extendCanvasWhileScrolling", false);
		expect(isOff(row(tab, "Zoom bar")), "the canvas went off under the open tab").toBe(false);
	});

	/** Greying a row nothing repaints leaves it live on screen until the tab is reopened. */
	it("asks the tab to draw itself again when the canvas moves", async () => {
		const tab = await tabFor({ extendCanvasWhileScrolling: false });
		let updates = 0;
		(tab as unknown as Record<string, unknown>).update = (): void => { updates++; };
		tab.setControlValue("extendCanvasWhileScrolling", true);
		expect(updates, "the tab was re-rendered for the rows the canvas decides").toBe(1);
	});
});

/**
 * The 1.12 painter. It honoured `disabled` on toggles and not on dropdowns, so a
 * dropdown row marked disabled rendered live. No real row is a disabled dropdown
 * now, so these cells pin the painter on a synthetic row defined here.
 */
describe("the legacy painter honours a disabled dropdown", () => {
	const syntheticDisabled: Row = {
		name: "Synthetic disabled dropdown",
		control: { type: "dropdown", key: "syntheticKey", disabled: (): boolean => true, options: { a: "A" } },
	};
	const syntheticLive: Row = {
		name: "Synthetic live dropdown",
		control: { type: "dropdown", key: "syntheticKey", disabled: (): boolean => false, options: { a: "A" } },
	};

	it("disables the dropdown of a row whose predicate says so", async () => {
		const tab = await tabFor({});
		expect(isOff(syntheticDisabled), "the synthetic row is disabled").toBe(true);

		rec.disabled.length = 0;
		const paint = (tab as unknown as { paint(el: unknown, items: readonly Row[]): void }).paint.bind(tab);
		paint({ empty: () => {} }, [syntheticDisabled]);
		expect(rec.disabled, "the painter disabled the dropdown").toContain("Synthetic disabled dropdown");
	});

	/** A live row must stay live: the painter disabling everything would also pass the cell above. */
	it("leaves a live dropdown alone", async () => {
		const tab = await tabFor({});
		rec.disabled.length = 0;
		const paint = (tab as unknown as { paint(el: unknown, items: readonly Row[]): void }).paint.bind(tab);
		paint({ empty: () => {} }, [syntheticLive]);
		expect(rec.disabled).not.toContain("Synthetic live dropdown");
	});
});
