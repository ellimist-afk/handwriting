import { describe, expect, it } from "vitest";
import { transformSync } from "esbuild";
import mainSource from "./main.ts?raw";

const source = mainSource.replace(/\r\n/g, "\n");
const start = "\tregisterHeaderActions(): void {";
const end = "\n\t}\n";

type Action = { icon: string; title: string; click: () => void; removed: boolean; classList: { add(c: string): void; contains(c: string): boolean; toggle(c: string, on: boolean): void } };
class FakeFile { constructor(public path: string, public extension = "md") {} }

function harness(global = false, initialPresence: "ink" | "none" | "unknown" = "ink", phone = false, availableIcons = new Set(["scan", "grid-3x-3", "layout-grid"])) {
	const at = source.indexOf(start);
	expect(at, "the registered header action method exists").toBeGreaterThanOrEqual(0);
	const stop = source.indexOf(end, at);
	expect(stop).toBeGreaterThan(at);
	const body = source.slice(at, stop + end.length).replace(start, "function () {");
	const callbacks = new Map<string, ((...args: unknown[]) => void)[]>();
	const watch = (name: string, cb: (...args: unknown[]) => void) => { callbacks.set(name, [...(callbacks.get(name) ?? []), cb]); return cb; };
	const fire = (name: string, ...args: unknown[]) => { for (const cb of callbacks.get(name) ?? []) cb(...args); };
	const actions: Action[] = [];
	const file = new FakeFile("ink.md");
	const view = { file, addAction(icon: string, title: string, click: () => void): Action {
		const classes = new Set<string>();
		const action: Action = { icon, title, click, removed: false,
			classList: { add: c => { classes.add(c); }, contains: c => classes.has(c), toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } } };
		(action as Action & { remove(): void }).remove = () => { action.removed = true; };
		actions.push(action);
		return action;
	} };
	let presence: "ink" | "none" | "unknown" = initialPresence;
	let override: boolean | "default" = "default";
	const writes: boolean[] = [];
	const frontmatter: { [key: string]: boolean } = {};
	let cornerRefreshes = 0;
	const warnings: string[] = [];
	const pickers: { opened: boolean }[] = [];
	const plugin = {
		settings: { extendCanvasWhileScrolling: global },
		headerActionRefresh: null as null | (() => void),
		refreshHeaderActions() { this.headerActionRefresh?.(); },
		saveSettingsNow() {},
		notePaper: { choice: () => "default", save: async () => {} },
		app: { workspace: { getLeavesOfType: () => [{ view }], on: watch, onLayoutReady: (cb: () => void) => cb() }, metadataCache: { on: watch } },
		registerEvent: (v: unknown) => v,
		register: (v: unknown) => v,
		applyCanvasChoice(_path: string, on: boolean) { writes.push(on); frontmatter["handwriting-canvas"] = on; override = on; fire("override", file.path); },
	};
	const deps = {
		getIcon: (name: string) => availableIcons.has(name) ? {} : null,
		apiVersion: "1.13.7",
		console: { warn: (message: string) => warnings.push(message) },
		getToolbarCorner: () => "top-right",
		setToolbarCorner: () => { cornerRefreshes++; },
		Platform: { isPhone: phone },
		inlineInk: { inkPresence: () => presence, ensureLoaded: async () => { if (presence === "unknown") presence = "ink"; } },
		canvasForNote: (_path: string, setting: boolean) => override === "default" ? setting : override,
		onCanvasOverrideChanged: (cb: (...args: unknown[]) => void) => watch("override", cb),
		onInkChanged: (cb: (...args: unknown[]) => void) => watch("ink", cb),
		NotePaperPicker: class { opened = false; constructor(..._args: unknown[]) { pickers.push(this); } open() { this.opened = true; } },
		blockNotice: () => {},
		TFile: FakeFile,
	};
	const code = transformSync(`return (${body})`, { loader: "ts", target: "es2022" }).code;
	const register = new Function(...Object.keys(deps), code)(...Object.values(deps)) as (this: typeof plugin) => void;
	register.call(plugin);
	const menuStart = '\t\tthis.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {';
	const menuAt = source.indexOf(menuStart);
	expect(menuAt).toBeGreaterThanOrEqual(0);
	const menuStop = source.indexOf("\n\t\t}));", menuAt);
	const menuCode = transformSync(`return function () { ${source.slice(menuAt, menuStop + 7)} }`, { loader: "ts", target: "es2022" }).code;
	(new Function(...Object.keys(deps), menuCode)(...Object.values(deps)) as (this: typeof plugin) => void).call(plugin);
	const openMenu = (): { title: string; checked: boolean }[] => {
		const items: { title: string; checked: boolean }[] = [];
		fire("file-menu", { addItem(build: (item: unknown) => void) {
			const record = { title: "", checked: false };
			const item = { setTitle(t: string) { record.title = t; return item; }, setIcon() { return item; }, setChecked(v: boolean) { record.checked = v; return item; }, onClick() { return item; } };
			build(item); items.push(record);
		} }, file);
		return items;
	};
	const controlStart = "\tsetControlValue(key: string, value: unknown): void {";
	const controlAt = source.indexOf(controlStart);
	expect(controlAt, "the settings control method exists").toBeGreaterThanOrEqual(0);
	const controlStop = source.indexOf(end, controlAt);
	expect(controlStop).toBeGreaterThan(controlAt);
	const controlBody = source.slice(controlAt, controlStop + end.length).replace(controlStart, "function (key: string, value: unknown) {");
	const controlDeps = { ...deps, setScrollExpansionEnabled: () => {}, setZoomBarCanvasEnabled: () => {}, refreshNoteZoomControlsAll: () => {} };
	const controlCode = transformSync(`return (${controlBody})`, { loader: "ts", target: "es2022" }).code;
	const control = new Function(...Object.keys(controlDeps), controlCode)(...Object.values(controlDeps)) as (this: { plugin: typeof plugin; rerender(): void }, key: string, value: unknown) => void;
	const paintStart = "\tprivate paint(el: HTMLElement, items: readonly LegacySettingItem[]): void {";
	const paintAt = source.indexOf(paintStart);
	expect(paintAt, "the settings painter exists").toBeGreaterThanOrEqual(0);
	const paintStop = source.indexOf(end, paintAt);
	expect(paintStop).toBeGreaterThan(paintAt);
	const paintBody = source.slice(paintAt, paintStop + end.length).replace(paintStart, "function (el: HTMLElement, items: readonly LegacySettingItem[]) {");
	const toggleCallback = { onChange: null as ((value: boolean) => void) | null };
	class RecordingSetting {
		constructor(_el: unknown) {}
		setName(_name: string) { return this; }
		addToggle(build: (toggle: unknown) => void) {
			const toggle = { setValue: (_value: boolean) => toggle, onChange: (handler: (value: boolean) => void) => { toggleCallback.onChange = handler; return toggle; } };
			build(toggle);
			return this;
		}
	}
	const paintCode = transformSync(`return (${paintBody})`, { loader: "ts", target: "es2022" }).code;
	const paint = new Function("Setting", paintCode)(RecordingSetting) as (this: unknown, el: unknown, items: unknown[]) => void;
	const tab = {
		plugin,
		rerender() {},
		getControlValue: (key: string) => plugin.settings[key as "extendCanvasWhileScrolling"],
		setControlValue(key: string, value: unknown) { control.call(this, key, value); },
		paint(el: unknown, items: unknown[]) { paint.call(this, el, items); },
	};
	tab.paint({}, [{ name: "Infinite canvas", control: { type: "toggle", key: "extendCanvasWhileScrolling" } }]);
	const changeGlobal = (on: boolean) => {
		const handler = toggleCallback.onChange;
		expect(handler, "the Infinite canvas toggle wires onChange").not.toBeNull();
		handler?.(on);
	};
	return { actions, file, view, plugin, writes, frontmatter, pickers, warnings, fire, openMenu, changeGlobal, cornerRefreshes: () => cornerRefreshes, setPresence: (v: typeof presence) => { presence = v; }, setPhone: (v: boolean) => { deps.Platform.isPhone = v; }, setOverride: (v: typeof override) => { override = v; fire("override", file.path); } };
}

describe("inked note header actions", () => {
	it("adds no action for a never-inked note or on a phone", () => {
		expect(harness(false, "none").actions).toEqual([]);
		expect(harness(false, "ink", true).actions).toEqual([]);
	});
	it("shows an existing inked note after its sidecar load settles", async () => {
		const h = harness(false, "unknown");
		expect(h.actions).toEqual([]);
		await Promise.resolve();
		expect(h.actions.filter(a => !a.removed).map(a => a.icon)).toEqual(["scan", "grid-3x-3"]);
	});
	it("shows scan and grid only for inked desktop or tablet notes", () => {
		const h = harness();
		expect(h.actions.filter(a => !a.removed).map(a => a.icon)).toEqual(["scan", "grid-3x-3"]);
		expect(h.cornerRefreshes()).toBe(1);
		h.setPresence("none"); h.fire("ink", h.file.path);
		expect(h.actions.filter(a => !a.removed)).toEqual([]);
		expect(h.cornerRefreshes()).toBe(2);
		h.setPresence("ink"); h.setPhone(true); h.fire("ink", h.file.path);
		expect(h.actions.filter(a => !a.removed)).toEqual([]);
	});
	it("resolves the paper icon against current, older, and fallback host tables", () => {
		const current = harness(false, "ink", false, new Set(["scan", "grid-3x-3", "layout-grid"]));
		const older = harness(false, "ink", false, new Set(["scan", "grid-3x3", "layout-grid"]));
		const fallback = harness(false, "ink", false, new Set(["scan", "layout-grid"]));
		const noScan = harness(false, "ink", false, new Set(["grid-3x-3", "layout-grid"]));
		const bothFallback = harness(false, "ink", false, new Set(["layout-grid"]));
		expect(current.actions[1]?.icon).toBe("grid-3x-3");
		expect(older.actions[1]?.icon).toBe("grid-3x3");
		expect(fallback.actions[1]?.icon).toBe("layout-grid");
		expect(noScan.actions.map(a => a.icon)).toEqual(["layout-grid", "grid-3x-3"]);
		expect(bothFallback.actions.map(a => a.icon)).toEqual(["layout-grid", "layout-grid"]);
		expect(current.warnings).toEqual([]);
		expect(older.warnings).toEqual([]);
		expect(fallback.warnings).toEqual(["Handwriting: paper grid unavailable in Obsidian 1.13.7; using layout-grid"]);
		expect(noScan.warnings).toEqual(["Handwriting: scan unavailable in Obsidian 1.13.7; using layout-grid"]);
		expect(bothFallback.warnings).toEqual(["Handwriting: scan, paper grid unavailable in Obsidian 1.13.7; using layout-grid"]);
	});
	it("lights the effective mode, writes opposite overrides, and refreshes after each change", () => {
		const h = harness(true);
		const canvas = h.actions[0]!;
		expect(canvas.classList.contains("is-active")).toBe(true);
		canvas.click();
		expect(h.writes).toEqual([false]);
		expect(h.frontmatter["handwriting-canvas"]).toBe(false);
		expect(canvas.classList.contains("is-active")).toBe(false);
		expect(h.openMenu()).toEqual([{ title: "Infinite canvas", checked: false }]);
		canvas.click();
		expect(h.writes).toEqual([false, true]);
		expect(h.frontmatter["handwriting-canvas"]).toBe(true);
		expect(canvas.classList.contains("is-active")).toBe(true);
		expect(h.openMenu()).toEqual([{ title: "Infinite canvas", checked: true }]);
		h.setOverride(false);
		expect(canvas.classList.contains("is-active")).toBe(false);
	});
	it("global off tap turns the note on and paper opens today's picker", () => {
		const h = harness(false);
		h.actions[0]!.click();
		expect(h.writes).toEqual([true]);
		h.actions[1]!.click();
		expect(h.pickers).toHaveLength(1);
		expect(h.pickers[0]!.opened).toBe(true);
		h.setPhone(true);
		expect(h.openMenu()).toEqual([{ title: "Infinite canvas", checked: true }]);
	});
	it("tracks a global setting change on an untouched note", () => {
		const h = harness(false);
		expect(h.actions[0]!.classList.contains("is-active")).toBe(false);
		h.changeGlobal(true);
		expect(h.actions[0]!.classList.contains("is-active")).toBe(true);
		h.changeGlobal(false);
		expect(h.actions[0]!.classList.contains("is-active")).toBe(false);
	});
});
