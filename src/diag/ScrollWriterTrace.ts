import { diagnosticsEnabled } from "./DiagSwitch";
import { focusStackNote } from "../inline/InlineFocus";
import { tr } from "../inline/InlinePenRouterTrace";

/** The slice of a window the scroll-writer hook patches: its Element prototype. */
export interface ScrollWriterWindow {
	Element?: { prototype: object };
}

/** The pen-trace row type for a script write that moved a note's scroller. */
export const SCROLL_WRITE_ROW = "scroll-write";

const NOTE_SCROLLER = "cm-scroller";
// Methods that scroll the element they are called on.
const OWN_SCROLLS = ["scrollTo", "scroll", "scrollBy"];
// Methods that scroll the note scroller holding the element they are called on.
const REVEALS = ["scrollIntoView", "scrollIntoViewIfNeeded"];

interface Patch {
	proto: object;
	key: string;
	original: PropertyDescriptor;
	installed: PropertyDescriptor;
}

interface Installed {
	live: { on: boolean };
	patches: Patch[];
}

type ScrollEl = {
	scrollTop: number;
	classList?: { contains(name: string): boolean };
	closest?(selector: string): unknown;
};

const installed = new Map<object, Installed>();
const lastWrite = new WeakMap<object, number>();

/** Where the last script write that moved this note scroller left it, taken once; null when none since the last take. */
export function takeScrollWrite(scroller: object): number | null {
	const top = lastWrite.get(scroller);
	if (top === undefined) return null;
	lastWrite.delete(scroller);
	return top;
}

/** Starts (on) or stops (off) recording script scroll writes on note scrollers into the pen trace. */
export function scrollWriterTrace(on: boolean, win: ScrollWriterWindow | null = mainWindow()): void {
	if (!on) {
		uninstallAll();
		return;
	}
	if (win && !installed.has(win)) install(win);
}

function mainWindow(): ScrollWriterWindow | null {
	return typeof window === "undefined" ? null : window;
}

function install(win: ScrollWriterWindow): void {
	const proto = win.Element?.prototype;
	if (!proto) return;
	const entry: Installed = { live: { on: true }, patches: [] };
	const top = Object.getOwnPropertyDescriptor(proto, "scrollTop");
	if (top?.get && top.set && top.configurable) {
		patch(entry, proto, "scrollTop", top, { ...top, set: scrollTopWriter(top, entry.live) });
	}
	for (const key of [...OWN_SCROLLS, ...REVEALS]) {
		const d = Object.getOwnPropertyDescriptor(proto, key);
		if (typeof d?.value !== "function" || !d.configurable) continue;
		patch(entry, proto, key, d, { ...d, value: scrollMethodWriter(key, d.value as (...args: unknown[]) => unknown, entry.live) });
	}
	installed.set(win, entry);
}

function patch(entry: Installed, proto: object, key: string, original: PropertyDescriptor, next: PropertyDescriptor): void {
	try {
		Object.defineProperty(proto, key, next);
		entry.patches.push({ proto, key, original, installed: next });
	} catch {
		// A prototype that refuses the patch keeps its own writer; nothing is recorded for it.
	}
}

function uninstallAll(): void {
	for (const entry of installed.values()) {
		entry.live.on = false;
		for (const p of entry.patches) {
			const now = Object.getOwnPropertyDescriptor(p.proto, p.key);
			const ours = p.key === "scrollTop" ? now?.set === p.installed.set : now?.value === p.installed.value;
			// A writer patched on top of ours keeps its place; ours under it now only passes through.
			if (!ours) continue;
			try {
				Object.defineProperty(p.proto, p.key, p.original);
			} catch {
				// A prototype frozen since keeps ours, which is off and only passes through.
			}
		}
	}
	installed.clear();
}

function scrollTopWriter(top: PropertyDescriptor, live: { on: boolean }) {
	return function writeScrollTop(this: ScrollEl, value: unknown): void {
		if (!live.on || !diagnosticsEnabled() || !isNoteScroller(this)) {
			top.set?.call(this, value);
			return;
		}
		const before = readTop(() => top.get?.call(this));
		top.set?.call(this, value);
		const after = readTop(() => top.get?.call(this));
		if (before !== null && after !== null && before !== after) {
			lastWrite.set(this, after);
			writeRow(before, after, `scrollTop=${round(Number(value))}`, new Error().stack ?? "");
		}
	};
}

function scrollMethodWriter(key: string, fn: (...args: unknown[]) => unknown, live: { on: boolean }) {
	const own = OWN_SCROLLS.includes(key);
	return function callScrollMethod(this: ScrollEl, ...args: unknown[]): unknown {
		const scroller = live.on && diagnosticsEnabled() ? noteScrollerFor(this, own) : null;
		if (!scroller) return fn.apply(this, args);
		const before = readTop(() => scroller.scrollTop);
		const result = fn.apply(this, args);
		const after = readTop(() => scroller.scrollTop);
		if (before !== null && after !== null && before !== after) {
			lastWrite.set(scroller, after);
			writeRow(before, after, key, new Error().stack ?? "");
		}
		return result;
	};
}

function isNoteScroller(el: ScrollEl): boolean {
	try {
		return el?.classList?.contains(NOTE_SCROLLER) === true;
	} catch {
		return false;
	}
}

function noteScrollerFor(el: ScrollEl, own: boolean): ScrollEl | null {
	if (own) return isNoteScroller(el) ? el : null;
	try {
		const found = el?.closest?.(`.${NOTE_SCROLLER}`) as ScrollEl | null | undefined;
		return found ?? null;
	} catch {
		return null;
	}
}

function readTop(read: () => unknown): number | null {
	try {
		const v = Number(read());
		return Number.isFinite(v) ? v : null;
	} catch {
		return null;
	}
}

function round(v: number): number {
	return Math.round(v * 10) / 10;
}

function writeRow(before: number, after: number, via: string, stack: string): void {
	try {
		tr(SCROLL_WRITE_ROW, null, `scrollTop ${round(before)} -> ${round(after)} via ${via}, stack: ${focusStackNote(stack) || "(none)"}`);
	} catch {
		// A failed row never reaches the writer.
	}
}
