export * from "./iphoneObsidianStub";
export { Modal } from "./paperPickerObsidian";

// Desktop platform flags; the shared stub also supplies CodeMirror's editor field.
export const Platform = {
	isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false,
	isDesktopApp: true, isMobileApp: false, isPhone: false, isTablet: false,
	isMacOS: false, isLinux: false, isWin: true,
};
