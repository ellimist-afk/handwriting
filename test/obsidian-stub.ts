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
