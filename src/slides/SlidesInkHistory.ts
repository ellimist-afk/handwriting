import type { InkStroke } from "../ink/Stroke";

export interface SlidesInkChange {
	index: number;
	before: readonly InkStroke[];
	after: readonly InkStroke[];
}

interface Entry {
	label: string;
	changes: SlidesInkChange[];
}

export const SLIDES_HISTORY_LIMIT = 100;

/**
 * Chronological history for one live deck. Callers finish gestures before
 * replay and clear history when adopting authoritative external ink.
 * Arrays are copied on record and replay. Committed stroke objects, including
 * their points, must be treated as immutable; replacements use new objects.
 * Persistence and slide navigation remain the deck's responsibility.
 */
export class SlidesInkHistory {
	private done: Entry[] = [];
	private undone: Entry[] = [];

	get undoLabel(): string | null {
		return this.done.at(-1)?.label ?? null;
	}

	get redoLabel(): string | null {
		return this.undone.at(-1)?.label ?? null;
	}

	record(label: string, changes: readonly SlidesInkChange[]): boolean {
		// Multiple changes to one bucket form a single before/after snapshot.
		const buckets = new Map<number, SlidesInkChange>();
		for (const change of changes) {
			const previous = buckets.get(change.index);
			buckets.set(change.index, {
				index: change.index,
				before: previous?.before ?? [...change.before],
				after: [...change.after],
			});
		}
		const effective = [...buckets.values()].filter(({ before, after }) =>
			before.length !== after.length || before.some((stroke, i) => stroke !== after[i])
		);
		if (effective.length === 0) return false;
		this.done.push({ label, changes: effective });
		if (this.done.length > SLIDES_HISTORY_LIMIT) this.done.shift();
		this.undone = [];
		return true;
	}

	undo(strokes: Map<number, InkStroke[]>): string | null {
		const entry = this.done.pop();
		if (!entry) return null;
		this.apply(strokes, entry, "before");
		this.undone.push(entry);
		return entry.label;
	}

	redo(strokes: Map<number, InkStroke[]>): string | null {
		const entry = this.undone.pop();
		if (!entry) return null;
		this.apply(strokes, entry, "after");
		this.done.push(entry);
		return entry.label;
	}

	clear(): void {
		this.done = [];
		this.undone = [];
	}

	/**
	 * Initial loading appends previously stored ink after local ink. Preserve
	 * those additions when replaying gestures completed before the load settled.
	 * This is only for newly adopted IDs at unchanged slide indices; a later
	 * authoritative replacement or remap requires clear(), not rebasing.
	 * The caller separately rebases any unfinished gesture's snapshot.
	 */
	rebaseInitial(
		additions: ReadonlyMap<number, readonly InkStroke[]>,
		resolveLocal: (stroke: InkStroke, index: number) => InkStroke = stroke => stroke,
	): void {
		const append = (snapshot: readonly InkStroke[], incoming: readonly InkStroke[]): InkStroke[] => {
			const result = [...snapshot];
			const ids = new Set(snapshot.map((stroke) => stroke.id));
			for (const stroke of incoming) {
				if (ids.has(stroke.id)) continue;
				ids.add(stroke.id);
				result.push(stroke);
			}
			return result;
		};
		for (const entry of [...this.done, ...this.undone]) {
			for (const change of entry.changes) {
				change.before = change.before.map(stroke => resolveLocal(stroke, change.index));
				change.after = change.after.map(stroke => resolveLocal(stroke, change.index));
				const incoming = additions.get(change.index);
				if (!incoming?.length) continue;
				change.before = append(change.before, incoming);
				change.after = append(change.after, incoming);
			}
		}
	}

	private apply(strokes: Map<number, InkStroke[]>, entry: Entry, side: "before" | "after"): void {
		for (const change of entry.changes) {
			const snapshot = change[side];
			if (snapshot.length) strokes.set(change.index, [...snapshot]);
			else strokes.delete(change.index);
		}
	}
}
