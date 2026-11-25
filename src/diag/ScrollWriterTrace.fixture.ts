import { formatInlinePenTrace } from "../inline/InlinePenRouterTrace";

/** The slots the scroll-writer hook may patch on an Element prototype. */
export const WRITER_SLOTS = ["scrollTop", "scrollTo", "scroll", "scrollBy", "scrollIntoView", "scrollIntoViewIfNeeded"] as const;

/** A stand-in for one window: an Element class with a scrollTop accessor and native-like scroll methods. */
export function fakeScrollWindow() {
	const reads = { count: 0 };
	const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
	class El {
		top = 0;
		constructor(
			readonly classes: string[] = [],
			readonly parent: El | null = null,
			readonly at = 0,
			readonly max = 5000
		) {}
		get classList() {
			return { contains: (name: string) => this.classes.includes(name) };
		}
		closest(selector: string): El | null {
			const name = selector.replace(/^\./, "");
			if (this.classes.includes(name)) return this;
			for (let n = this.parent; n; n = n.parent) if (n.classes.includes(name)) return n;
			return null;
		}
		get scrollTop(): number {
			reads.count++;
			return this.top;
		}
		set scrollTop(v: number) {
			if (typeof v !== "number") throw new TypeError("not a number");
			this.top = clamp(v, this.max);
		}
		// Native scroll methods move the box without going through the scrollTop setter or each other.
		scrollTo(a?: unknown, b?: unknown): void {
			moveTo(this, a, b);
		}
		scroll(a?: unknown, b?: unknown): void {
			moveTo(this, a, b);
		}
		scrollBy(a?: unknown, b?: unknown): void {
			const dy = topArg(a, b);
			if (dy !== undefined) this.top = clamp(this.top + dy, this.max);
		}
		scrollIntoView(): void {
			reveal(this);
		}
		scrollIntoViewIfNeeded(): void {
			reveal(this);
		}
	}
	const topArg = (a: unknown, b: unknown) =>
		typeof a === "object" && a !== null ? (a as { top?: number }).top : typeof b === "number" ? b : undefined;
	const moveTo = (el: El, a: unknown, b: unknown) => {
		const top = topArg(a, b);
		if (top !== undefined) el.top = clamp(top, el.max);
	};
	const reveal = (el: El) => {
		const s = el.closest("cm-scroller");
		if (s && s !== el) s.top = clamp(el.at, s.max);
	};
	// The global timers, read at each call so vitest's fake timers stand in for them.
	const timers = () => ({ setTimeout, clearTimeout });
	const win = {
		Element: El,
		setTimeout: (fn: () => void, ms?: number) => timers().setTimeout(fn, ms),
		clearTimeout: (id: ReturnType<typeof setTimeout>) => timers().clearTimeout(id),
	};
	const scroller = (top: number) => {
		const s = new El(["cm-scroller"]);
		s.top = top;
		return s;
	};
	const child = (s: El, at: number) => new El(["cm-line"], s, at);
	const other = (top: number) => {
		const o = new El(["markdown-preview-view"]);
		o.top = top;
		return o;
	};
	return { win, El, reads, scroller, child, other };
}

/** Each slot's own function (the setter for scrollTop), to compare by identity. */
export function writerSlots(proto: object): unknown[] {
	return WRITER_SLOTS.map((key) => {
		const d: { set?: unknown; value?: unknown } | undefined = Object.getOwnPropertyDescriptor(proto, key);
		return key === "scrollTop" ? d?.set : d?.value;
	});
}

/** The pen trace's scroll-write rows, as printed. */
export function scrollRows(): string[] {
	return formatInlinePenTrace()
		.split("\n")
		.filter((line) => /ms {2}scroll-write /.test(line));
}
