/**
 * The Obsidian stub for FingerBoxDragAfterPan.test.ts: the iPhone stub as it is, plus `displayTooltip`, which the
 * lasso's Attach button imports and the shared stub does not yet export. Calls are counted on the window so a run
 * shows whether the finger path ever reached it; it draws nothing.
 */
export * from "./iphoneObsidianStub";

export function displayTooltip(_el: HTMLElement, _text: string, _opts?: unknown): void {
	const w = window as unknown as { __tooltipCalls?: number };
	w.__tooltipCalls = (w.__tooltipCalls ?? 0) + 1;
}
