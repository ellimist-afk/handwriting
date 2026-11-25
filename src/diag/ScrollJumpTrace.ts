import { diagnosticsEnabled, diagnosticsEpoch } from "./DiagSwitch";
import { takeScrollWrite } from "./ScrollWriterTrace";
import { liveScrollers, tr } from "../inline/InlinePenRouterTrace";

/** The pen-trace row type for a note scroller move with no hand scroll behind it, or a big step during one. */
export const SCROLL_JUMP_ROW = "scroll-jump";

/** A hand input on a note scroller. */
export type HandInput = "wheel" | "touch" | "key" | "scrollbar" | "pen" | "mouse";

/** The slice of a window the hand-input listeners go on. */
export interface HandInputWindow {
	addEventListener(type: string, fn: (e: Event) => void, opts: AddEventListenerOptions): void;
	removeEventListener(type: string, fn: (e: Event) => void, opts: EventListenerOptions): void;
}

/** The slice of a note scroller the jump check reads. */
export interface JumpScroller {
	readonly scrollHeight: number;
	readonly clientWidth?: number;
	readonly clientHeight?: number;
	readonly ownerDocument?: { defaultView?: unknown } | null;
	contains?(node: unknown): boolean;
}

const HAND_MS = 150;
const BIG_STEP_PX = 200;
const CAP_ROWS = 8;
const CAP_WINDOW_MS = 1000;
const INPUT_TYPES = ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "keydown"];
const LISTEN: AddEventListenerOptions = { capture: true, passive: true };

interface Hands {
	epoch: number;
	wheel: number;
	touch: number;
	key: number;
	bar: number;
	last: HandInput | null;
	lastAt: number;
}

interface Place {
	epoch: number;
	top: number;
	height: number;
	windowAt: number;
	rows: number;
	skipped: number;
}

const hands = new WeakMap<object, Hands>();
const places = new WeakMap<object, Place>();
const attached = new Map<HandInputWindow, () => void>();
let recording = false;
let penDown = false;
let barDrag: object | null = null;

/** Starts (on) or stops (off) the hand-input listeners the jump row reads, on the main window and every live note's window. */
export function handInputTrace(on: boolean, win: HandInputWindow | null = mainWindow()): void {
	recording = on;
	if (!on) {
		for (const off of attached.values()) off();
		attached.clear();
		penDown = false;
		barDrag = null;
		return;
	}
	if (win) attach(win);
	for (const s of liveScrollers) attach(windowOf(s));
}

/** A hand input seen by an existing listener of the scroller's own (the overlay's wheel tap). */
export function noteHandInput(scroller: object, input: HandInput): void {
	if (!diagnosticsEnabled()) return;
	stamp(scroller, input, performance.now());
}

/** One scroll event on a note scroller: writes a row for a move nobody asked for, or a step of 200 px or more during a hand scroll. */
export function scrollJumpCheck(scroller: JumpScroller, top: number, duringStroke: boolean): void {
	if (!diagnosticsEnabled()) return;
	if (recording) attach(windowOf(scroller));
	const epoch = diagnosticsEpoch();
	const now = performance.now();
	const height = readNumber(() => scroller.scrollHeight);
	const write = takeScrollWrite(scroller);
	const place = places.get(scroller);
	if (!place || place.epoch !== epoch) {
		places.set(scroller, { epoch, top, height, windowAt: now, rows: 0, skipped: 0 });
		return;
	}
	const from = place.top;
	const fromHeight = place.height;
	place.top = top;
	place.height = height;
	const step = top - from;
	if (Math.abs(step) < 1) return;
	const h = handsOf(scroller, epoch);
	const dragging = barDrag === scroller;
	const hand = dragging || (h !== null && now - Math.max(h.wheel, h.touch, h.key, h.bar) < HAND_MS);
	const explained = write !== null && Math.abs(write - top) <= 1;
	const big = Math.abs(step) >= BIG_STEP_PX;
	if (hand ? !big : explained) return;
	if (!big) {
		if (place.rows > 0 && now - place.windowAt >= CAP_WINDOW_MS) place.rows = 0;
		if (place.rows === 0) place.windowAt = now;
		if (place.rows >= CAP_ROWS) {
			place.skipped++;
			return;
		}
		place.rows++;
	}
	const skipped = place.skipped;
	place.skipped = 0;
	const age = (at: number | undefined) => (at === undefined || !Number.isFinite(at) ? "never" : `${Math.round(now - at)}ms`);
	const withWrite = write === null ? "no" : explained ? "yes" : `yes, to ${round(write)}`;
	const last = h?.last ? `${h.last} ${age(h.lastAt)} ago` : "none";
	writeRow(
		`${hand ? "hand scroll" : "no hand scroll"}: scrollTop ${round(from)} -> ${round(top)} (${step > 0 ? "+" : ""}${round(step)}) in one scroll event, ` +
			`scrollHeight at last scroll=${round(fromHeight)} now=${round(height)}, scroll-write with it=${withWrite}, ` +
			`ms since wheel=${age(h?.wheel)} touch=${age(h?.touch)} key=${age(h?.key)} scrollbar=${dragging ? "dragging" : age(h?.bar)}, ` +
			`last input=${last}, during stroke=${duringStroke ? "yes" : "no"}` +
			(skipped > 0 ? `, ${skipped} small rows skipped by the cap before this` : "")
	);
}

function mainWindow(): HandInputWindow | null {
	return typeof window === "undefined" ? null : window;
}

function windowOf(scroller: JumpScroller): HandInputWindow | null {
	try {
		const view = scroller.ownerDocument?.defaultView as Partial<HandInputWindow> | null | undefined;
		return typeof view?.addEventListener === "function" && typeof view.removeEventListener === "function" ? (view as HandInputWindow) : null;
	} catch {
		return null;
	}
}

function attach(win: HandInputWindow | null): void {
	if (!win || attached.has(win)) return;
	try {
		for (const type of INPUT_TYPES) win.addEventListener(type, onInput, LISTEN);
	} catch {
		// A window that refuses a listener records no hand input.
	}
	attached.set(win, () => {
		try {
			for (const type of INPUT_TYPES) win.removeEventListener(type, onInput, { capture: true });
		} catch {
			// A window already gone has no listener left to take off.
		}
	});
}

function handsOf(scroller: object, epoch: number): Hands | null {
	const h = hands.get(scroller);
	return h && h.epoch === epoch ? h : null;
}

function stamp(scroller: object, input: HandInput, now: number): void {
	const epoch = diagnosticsEpoch();
	let h = handsOf(scroller, epoch);
	if (!h) {
		const never = Number.NEGATIVE_INFINITY;
		h = { epoch, wheel: never, touch: never, key: never, bar: never, last: null, lastAt: never };
		hands.set(scroller, h);
	}
	if (input === "wheel") h.wheel = now;
	else if (input === "touch") h.touch = now;
	else if (input === "key") h.key = now;
	else if (input === "scrollbar") h.bar = now;
	h.last = input;
	h.lastAt = now;
}

function onInput(e: Event): void {
	if (!diagnosticsEnabled()) return;
	try {
		const now = performance.now();
		const scroller = scrollerOf(e.target);
		const type = e.type;
		if (type.startsWith("pointer")) {
			onPointer(e as PointerEvent, type, scroller, now);
			return;
		}
		if (!scroller) return;
		if (type === "keydown") {
			stamp(scroller, "key", now);
			return;
		}
		const touches = (e as TouchEvent).changedTouches as ArrayLike<{ touchType?: string }> | undefined;
		const stylus = touches ? Array.from(touches).some((t) => t?.touchType === "stylus") : false;
		stamp(scroller, penDown || stylus ? "pen" : "touch", now);
	} catch {
		// A failed read records nothing for that event.
	}
}

function onPointer(e: PointerEvent, type: string, scroller: JumpScroller | null, now: number): void {
	if (e.pointerType === "pen") {
		if (type === "pointerdown") penDown = true;
		else if (type === "pointerup" || type === "pointercancel") penDown = false;
		if (scroller && type !== "pointermove") stamp(scroller, "pen", now);
		if (type === "pointerdown") barDrag = null;
		return;
	}
	if (type === "pointerdown") {
		barDrag = null;
		if (!scroller || e.pointerType === "touch") return;
		const onBar = (e.target as unknown) === scroller && onScrollbar(e, scroller);
		if (onBar) barDrag = scroller;
		stamp(scroller, onBar ? "scrollbar" : "mouse", now);
		return;
	}
	if (!barDrag) return;
	if (type === "pointermove" && e.buttons !== 0) {
		stamp(barDrag, "scrollbar", now);
		return;
	}
	stamp(barDrag, "scrollbar", now);
	barDrag = null;
}

function onScrollbar(e: PointerEvent, scroller: JumpScroller): boolean {
	const w = scroller.clientWidth;
	const h = scroller.clientHeight;
	return (typeof w === "number" && e.offsetX >= w) || (typeof h === "number" && e.offsetY >= h);
}

function scrollerOf(target: EventTarget | null): JumpScroller | null {
	if (!target) return null;
	for (const s of liveScrollers) {
		const el = s as unknown as JumpScroller;
		if ((el as unknown) === target || el.contains?.(target)) return el;
	}
	return null;
}

function readNumber(read: () => unknown): number {
	try {
		const v = Number(read());
		return Number.isFinite(v) ? v : Number.NaN;
	} catch {
		return Number.NaN;
	}
}

function round(v: number): number {
	return Math.round(v * 10) / 10;
}

function writeRow(note: string): void {
	try {
		tr(SCROLL_JUMP_ROW, null, note);
	} catch {
		// A failed row never reaches the scroll listener.
	}
}
