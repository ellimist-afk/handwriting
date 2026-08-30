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
export class Plugin {}
export class PluginSettingTab {}
export class Modal {}
export class Setting {}
export class ItemView {}
export class TextFileView {}
export class MarkdownRenderChild {}
export class MarkdownRenderer {}
export class Notice {}
export class App {}
export class TFile {}
export class TAbstractFile {}
export class WorkspaceLeaf {}

export const Platform = {
	isMobile: false,
	isDesktop: true,
	isIosApp: false,
	isAndroidApp: false,
};

export const apiVersion = "0.0.0-test";
export const editorInfoField = {};
export function normalizePath(path: string): string {
	return path;
}
export function setIcon(): void {}
