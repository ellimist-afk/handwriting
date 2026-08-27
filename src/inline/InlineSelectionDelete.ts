import type { InkOp } from "./InkHistory";
import type { InlineInkStore } from "./InlineInkStore";

type RemoveOp = Extract<InkOp, { type: "remove" }>;
type DeleteKey = "Delete" | "Backspace";

interface DeleteKeyEvent {
	key: string;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	/** OS key-repeat flag; absent on synthetic events, treated as false. */
	repeat?: boolean;
	preventDefault(): void;
}

/** Remove exactly the selected strokes and capture enough state for undo. */
export function removeSelectedInlineStrokes(
	store: InlineInkStore,
	path: string,
	strokeIds: readonly string[]
): RemoveOp | null {
	const removed = store.applyRemove(path, strokeIds);
	if (removed.length === 0) return null;
	return {
		type: "remove",
		path,
		strokes: removed.map((item) => item.stroke),
		indices: removed.map((item) => item.index),
	};
}

/**
 * Own Delete or Backspace only after an ink selection claimed that key press.
 * The held-key state matters: after the first event clears the selection,
 * keyboard repeat must not fall through and start deleting Markdown.
 */
export class InlineSelectionDeleteKeys {
	private held: DeleteKey | null = null;

	constructor(
		private readonly hasSelection: () => boolean,
		private readonly removeSelection: () => void
	) {}

	keydown(event: DeleteKeyEvent): boolean {
		const key = this.deleteKey(event.key);
		if (!key) return false;
		if (this.held === key) {
			// The latch exists ONLY to keep key-repeat from cascading into
			// Markdown after the first event cleared the selection. A FRESH
			// press means the matching keyup was lost (focus moved between
			// down and up), and swallowing it made Delete silently dead for
			// the rest of the session (hardware, 2026-08-27): heal the latch
			// and let the press through.
			if (event.repeat) {
				event.preventDefault();
				return true;
			}
			this.held = null;
		}
		if (event.altKey || event.ctrlKey || event.metaKey || !this.hasSelection()) return false;
		this.held = key;
		event.preventDefault();
		this.removeSelection();
		return true;
	}

	keyup(event: DeleteKeyEvent): boolean {
		const key = this.deleteKey(event.key);
		if (!key || this.held !== key) return false;
		this.held = null;
		event.preventDefault();
		return true;
	}

	reset(): void {
		this.held = null;
	}

	private deleteKey(key: string): DeleteKey | null {
		return key === "Delete" || key === "Backspace" ? key : null;
	}
}
