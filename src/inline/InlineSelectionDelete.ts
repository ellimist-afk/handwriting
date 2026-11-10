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

/**
 * What a lasso delete actually did, so its caller can tell the two failures
 * apart.
 *
 * One number could not: `deleteSelectedInk` used to answer 0 both when the
 * user had selected nothing and when a real selection was matched by NOTHING
 * in the store, and the command site turned both into "lasso some ink first".
 * The second is a lie - the user HAD lassoed - and it was reported from
 * public (r/ObsidianMD, Boox, 2026-09-07).
 */
export type DeleteSelectionOutcome =
	/** Strokes were removed. `count` is how many were selected. */
	| { kind: "deleted"; count: number }
	/** Nothing was selected, or there is no path to delete from. */
	| { kind: "empty" }
	/** A real selection whose ids the store matched none of. */
	| { kind: "unmatched"; count: number };

/**
 * The notice a lasso delete owes the user, or `null` when it owes none.
 *
 * Pure and exported so both strings are pinned by EXECUTION rather than by
 * reading `main.ts` as text - the empty-selection string in particular must
 * stay byte-identical, since it is the one that was always true.
 */
export function lassoDeleteNotice(outcome: DeleteSelectionOutcome): string | null {
	if (outcome.kind === "deleted") return null;
	if (outcome.kind === "empty") return "Handwriting: lasso some ink first";
	// Says what happened and what is true NOW. No blame, and no "try again":
	// re-lassoing the same strokes fails the same way, so telling the user to
	// retry would waste their time. The selection is deliberately still on
	// screen, which is the one thing that lets them do anything else with it.
	return "Handwriting: could not remove the selected ink - the lasso has been kept";
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

	/**
	 * `editorIdle` answers whether the editor's own selection is empty. A swept
	 * text range means the key is meant for the text, as Ctrl+C and Ctrl+X
	 * already leave a range to the editor; the ink stays selected and the key
	 * is not taken.
	 */
	keydown(event: DeleteKeyEvent, editorIdle: () => boolean = () => true): boolean {
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
		if (event.altKey || event.ctrlKey || event.metaKey || !this.hasSelection() || !editorIdle()) return false;
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
