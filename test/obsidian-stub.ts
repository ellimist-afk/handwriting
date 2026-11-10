/**
 * A runtime stand-in for the `obsidian` package, used only by the test run.
 *
 * The real package ships types and no runtime entry, so any module that
 * imports it cannot be loaded by vitest at all. That is not a small detail:
 * it is why the surfaces that actually hold the pen had no tests, and why a
 * lasso could ship unreachable without a single failure.
 *
 * Nothing here does any work. The exports exist so a module graph can be
 * loaded; a test that needs real behaviour should mock the specific thing it
 * needs rather than teach this file to pretend.
 */

export class Component {}
export function requestUrl(): never { throw new Error("network requests are unavailable in tests"); }
export class Plugin {}
export class PluginSettingTab {}
export class Modal {}
export class Setting {}
export class View {}
export class ItemView {}
export class TextFileView {}
export class MarkdownRenderChild {}
export class MarkdownRenderer {}
export class MarkdownView {}
export class SuggestModal {}
export class Notice {}
/**
 * The one stand-in that records: a menu keeps the items added to it and where it was shown, so a test can read what a tap
 * offered and click an item. Nothing is drawn.
 */
export class MenuItem {
	title = "";
	icon = "";
	click: (() => void) | null = null;
	setTitle(title: string): this { this.title = title; return this; }
	setIcon(icon: string): this { this.icon = icon; return this; }
	onClick(fn: () => void): this { this.click = fn; return this; }
}
export class Menu {
	static last: Menu | null = null;
	items: MenuItem[] = [];
	shownAt: { x: number; y: number } | null = null;
	constructor() { Menu.last = this; }
	addItem(fn: (item: MenuItem) => void): this { const item = new MenuItem(); fn(item); this.items.push(item); return this; }
	showAtPosition(at: { x: number; y: number }): this { this.shownAt = { x: at.x, y: at.y }; return this; }
	hide(): this { return this; }
}
export class App {}
export class TFile {}
export class TAbstractFile {}
export class WorkspaceLeaf {}

// The settings tab imports these; empty classes let its module graph load.
export class ButtonComponent {}
export class ColorComponent {}
export class ExtraButtonComponent {}

// Flags shipped code reads (audit-fixes-design.md s3 A3, 2026-09-02): grep
// for Platform.is\w+ under src/ gives isAndroidApp isDesktopApp isIosApp
// isLinux isMacOS isMobileApp isPhone isTablet isWin, plus isMobile/isDesktop
// which predate that grep and something still reads. Set to match the
// machine tests actually run on - desktop Windows - not a real device.
export const Platform = {
	isMobile: false,
	isDesktop: true,
	isIosApp: false,
	isAndroidApp: false,
	isDesktopApp: true,
	isMobileApp: false,
	isPhone: false,
	isTablet: false,
	isMacOS: false,
	isLinux: false,
	isWin: true,
};

export const apiVersion = "0.0.0-test";
export const editorInfoField = {};
export function normalizePath(path: string): string {
	return path;
}
export function setIcon(): void {}
export function displayTooltip(): void {}
export function getIcon(): null { return null; }
