export * from "./iphoneObsidianStub";
export { Modal } from "./paperPickerObsidian";

// Desktop platform flags; the shared stub also supplies CodeMirror's editor field.
export const Platform = {
	isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false,
	isDesktopApp: true, isMobileApp: false, isPhone: false, isTablet: false,
	isMacOS: false, isLinux: false, isWin: true,
};

// The settings tab imports these; the page never opens the tab, so empty classes let the bundle resolve.
export class ButtonComponent {}
export class ColorComponent {}
export class ExtraButtonComponent {}
