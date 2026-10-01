/**
 * THE THREE SETTINGS-SIDE CHANGES OF THE INFINITE CANVAS SETTINGS WORK.
 *
 *   Infinite Canvas   the row's description says what turning it on turns on.
 *   Zoom bar          the row is greyed out while Infinite Canvas is off - the
 *                     zoom bar cannot show without the canvas - and says why.
 *                     Both the definition's `disabled` predicate and the 1.12
 *                     painter that has to honour it are pinned: the painter
 *                     honoured `disabled` on toggles only, so a dropdown row
 *                     marked disabled rendered live and changed a setting the
 *                     user could not see the effect of.
 *   The canvas toggle re-renders the tab, so the Zoom bar row greys the moment
 *                     the canvas is switched off rather than at the next open.
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
		expect(row(tab, "Infinite canvas").desc).toBe("Turns on Infinite canvas. Also turns on zoom bar. Default off.");
	});
});

describe("the Zoom bar row is greyed out without the canvas", () => {
	it("says what it needs", async () => {
		const tab = await tabFor({});
		expect(row(tab, "Zoom bar").desc).toContain("Needs Infinite canvas.");
	});

	it("is disabled with the canvas off and live with it on", async () => {
		const off = await tabFor({ extendCanvasWhileScrolling: false });
		expect(isOff(row(off, "Zoom bar")), "canvas off: the row cannot be used").toBe(true);

		const on = await tabFor({ extendCanvasWhileScrolling: true });
		expect(isOff(row(on, "Zoom bar")), "canvas on: the row is live").toBe(false);
	});

	/**
	 * The predicate is read at render time, so the row has to be re-read after
	 * the canvas moves - and it is the SAME tab object, not a fresh load: a
	 * predicate that closed over the value it saw at definition time would
	 * pass the two cells above and fail this one.
	 */
	it("follows the canvas toggle on the tab that is already open", async () => {
		const tab = await tabFor({ extendCanvasWhileScrolling: true });
		// 1.13 owns the redraw; this cell is about the predicate, not the redraw.
		(tab as unknown as Record<string, unknown>).update = (): void => {};
		expect(isOff(row(tab, "Zoom bar"))).toBe(false);
		tab.setControlValue("extendCanvasWhileScrolling", false);
		expect(isOff(row(tab, "Zoom bar")), "the canvas went off under the open tab").toBe(true);
		tab.setControlValue("extendCanvasWhileScrolling", true);
		expect(isOff(row(tab, "Zoom bar"))).toBe(false);
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
 * The 1.12 painter. It honoured `disabled` on toggles and not on dropdowns, and
 * the Zoom bar row is a dropdown: without this the row greys on 1.13 and stays
 * live on 1.12, leaving a control that moves when pressed and changes a setting
 * whose effect is switched off.
 */
describe("the legacy painter honours a disabled dropdown", () => {
	it("disables the dropdown of a row whose predicate says so", async () => {
		const tab = await tabFor({ extendCanvasWhileScrolling: false });
		const zoom = row(tab, "Zoom bar");
		expect(zoom.control?.type, "the Zoom bar row is a dropdown, which is the gap").toBe("dropdown");
		expect(isOff(zoom), "and it is disabled with the canvas off").toBe(true);

		rec.disabled.length = 0;
		const paint = (tab as unknown as { paint(el: unknown, items: readonly Row[]): void }).paint.bind(tab);
		paint({ empty: () => {} }, [zoom]);
		expect(rec.disabled, "the painter disabled the dropdown").toContain("Zoom bar");
	});

	/** A live row must stay live: the painter disabling everything would also pass the cell above. */
	it("leaves the dropdown alone with the canvas on", async () => {
		const tab = await tabFor({ extendCanvasWhileScrolling: true });
		rec.disabled.length = 0;
		const paint = (tab as unknown as { paint(el: unknown, items: readonly Row[]): void }).paint.bind(tab);
		paint({ empty: () => {} }, [row(tab, "Zoom bar")]);
		expect(rec.disabled).not.toContain("Zoom bar");
	});
});
