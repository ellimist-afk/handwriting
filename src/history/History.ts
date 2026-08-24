/**
 * Undo/redo as explicit operations (handoff §23). Every mutation the canvas
 * makes goes through here, so undo is never a guess about what changed.
 *
 * Text editing is deliberately NOT in this stack: while a text editor has
 * focus, Ctrl+Z belongs to the editor. The view decides which stack owns the
 * keystroke; History only owns canvas operations.
 */
export interface Op {
	label: string;
	apply(): void;
	invert(): void;
}

const LIMIT = 200;

export class History {
	private undoStack: Op[] = [];
	private redoStack: Op[] = [];
	private onChange: (() => void) | undefined;

	constructor(onChange?: () => void) {
		this.onChange = onChange;
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	get depth(): number {
		return this.undoStack.length;
	}

	/** Apply an operation and make it undoable. */
	run(op: Op): void {
		op.apply();
		this.push(op);
	}

	/**
	 * Record an operation that has ALREADY been applied. The ink path applies
	 * as it draws, and re-applying a finished stroke would be wasted work.
	 */
	push(op: Op): void {
		this.undoStack.push(op);
		if (this.undoStack.length > LIMIT) this.undoStack.shift();
		this.redoStack = [];
		this.onChange?.();
	}

	undo(): Op | undefined {
		const op = this.undoStack.pop();
		if (!op) return undefined;
		op.invert();
		this.redoStack.push(op);
		this.onChange?.();
		return op;
	}

	redo(): Op | undefined {
		const op = this.redoStack.pop();
		if (!op) return undefined;
		op.apply();
		this.undoStack.push(op);
		this.onChange?.();
		return op;
	}

	clear(): void {
		this.undoStack = [];
		this.redoStack = [];
		this.onChange?.();
	}
}
