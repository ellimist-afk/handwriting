/**
 * The Obsidian stub for AttachOrionRef.test.ts: the finger arm's stub (the iPhone stub plus a counted displayTooltip), and a
 * Notice that keeps every message on the window, so a cell shows what the user was told ("no text" from the Attach tap).
 */
export * from "./fingerArmObsidian";

export class Notice {
	constructor(message: string) {
		const w = window as unknown as { __notices?: string[] };
		(w.__notices ??= []).push(String(message));
	}
}
