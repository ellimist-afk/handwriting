/** A handle belongs to one mounted deck. Its methods revalidate that lifetime. */
export type SlidesAction = "undo" | "redo" | "clear-current" | "clear-all";
export interface SlidesStatus {
	revision: number;
	pendingGesture: boolean;
	live: boolean;
	mutable: boolean;
	index: number;
	currentCount: number;
	totalCount: number;
	undoLabel: string | null;
	redoLabel: string | null;
}
export interface SlidesActions {
	readonly ownerDocument: Document;
	status(): SlidesStatus;
	run(action: SlidesAction): boolean;
	finishGesture(): void;
	/** Repaint committed ink after a render-only setting changes. */
	repaintSettings?(): void;
	onChange(fn: () => void): () => void;
}

export function slideActionAvailable(status: SlidesStatus, action: SlidesAction): boolean {
	if (!status.live || !status.mutable) return false;
	if (action === "undo") return status.undoLabel !== null || status.pendingGesture;
	if (action === "redo") return status.redoLabel !== null;
	return (action === "clear-current" ? status.currentCount : status.totalCount) > 0 || status.pendingGesture;
}

/** Uses owner nodes rather than the main window's Element constructor (popouts). */
export function isSlidesControl(target: EventTarget | null, root: HTMLElement): boolean {
	let el = target as HTMLElement | null;
	while (el && el !== root) {
		if (el.classList?.contains("slides-close-btn") ||
			el.classList?.contains("controls") ||
			el.classList?.contains("handwriting-slides-tools")) return true;
		el = el.parentElement;
	}
	return false;
}
