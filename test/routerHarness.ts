/**
 * The thinnest DOM the router's constructor will hold still for, extracted
 * verbatim from InkFeedRouting.test.ts so the replay harness can drive the
 * SAME real router the feed tests do. One copy on purpose: two hand-rolled
 * element fakes would drift, and the drift would show up as replay results
 * that disagree with the feed tests for reasons that are neither's fault.
 *
 * An element fake records addEventListener registrations so callers invoke
 * the capture handlers directly, and a window stub catches the mirror and
 * the end backstop. No jsdom; this runs where every other test runs.
 */

import { InlinePenCallbacks, InlinePenRouter } from "../src/inline/InlinePenRouter";
import { PenSample } from "../src/input/PointerRouter";

export type Handler = (ev: Event) => void;

/**
 * Window-level capture registrations land here. The touch guards live on the
 * window rather than the scroller precisely so nothing above them can act
 * first, so a test that fired them on the element would be testing the wrong
 * thing.
 */
export const winHandlers = new Map<string, Handler>();

/**
 * Install the window stub when the environment has none. Returns the undo.
 * Callers run this in beforeAll and the undo in afterAll; the flag protects
 * a real window (jsdom or browser) from being clobbered.
 */
export function installFakeWindow(): () => void {
	const had = "window" in globalThis;
	if (!had) {
		(globalThis as Record<string, unknown>).window = {
			addEventListener: (type: string, h: Handler) => void winHandlers.set(type, h),
			removeEventListener: () => {},
			setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
			clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
		};
	}
	return () => {
		if (!had) delete (globalThis as Record<string, unknown>).window;
	};
}

// ---- element fake ----------------------------------------------------------

export function fakeEl() {
	const handlers = new Map<string, Handler>();
	const classes = new Set<string>();
	const el = {
		handlers,
		/** Replaced below with an identity check; the guards ask this. */
		contains: (_node: unknown) => false,
		style: { touchAction: "" },
		scrollLeft: 0,
		scrollTop: 0,
		setCssStyles(styles: { touchAction?: string }) {
			if (styles.touchAction !== undefined) this.style.touchAction = styles.touchAction;
		},
		classList: {
			add: (c: string) => void classes.add(c),
			remove: (c: string) => void classes.delete(c),
			contains: (c: string) => classes.has(c),
			toggle: (c: string, on?: boolean) => {
				const want = on ?? !classes.has(c);
				if (want) classes.add(c);
				else classes.delete(c);
				return want;
			},
		},
		addEventListener(type: string, h: Handler) {
			handlers.set(type, h);
		},
		removeEventListener() {},
		getBoundingClientRect: () => ({
			left: 0,
			top: 0,
			right: 800,
			bottom: 600,
			width: 800,
			height: 600,
			x: 0,
			y: 0,
		}),
		setPointerCapture() {},
		releasePointerCapture() {},
	};
	el.contains = (node: unknown) => node === el;
	return el;
}

// ---- event factory ---------------------------------------------------------

export interface PenOpts {
	x?: number;
	y?: number;
	pressure?: number;
	buttons?: number;
	pointerType?: string;
	tiltX?: number;
	tiltY?: number;
	/** Timestamps for the coalesced list; each becomes one sample. */
	coalesced?: number[];
	/** Full coalesced samples, when a replay carries real geometry. */
	coalescedSamples?: Array<{ t: number; x: number; y: number; pressure: number }>;
}

export function penEvent(type: string, ts: number, opts: PenOpts = {}): PointerEvent {
	const {
		x = 100,
		y = 100,
		pressure = 0.4,
		buttons = 1,
		pointerType = "pen",
		tiltX = 0,
		tiltY = 0,
		coalesced,
		coalescedSamples,
	} = opts;
	const base = {
		type,
		pointerType,
		pointerId: 7,
		isPrimary: true,
		clientX: x,
		clientY: y,
		pressure,
		buttons,
		button: 0,
		timeStamp: ts,
		tiltX,
		tiltY,
		width: 0,
		height: 0,
		preventDefault: () => {},
		stopPropagation: () => {},
	};
	const ev = { ...base } as Record<string, unknown>;
	if (coalescedSamples) {
		ev.getCoalescedEvents = () =>
			coalescedSamples.map(
				(s) =>
					({
						...base,
						timeStamp: s.t,
						clientX: s.x,
						clientY: s.y,
						pressure: s.pressure,
					}) as unknown as PointerEvent
			);
	} else if (coalesced) {
		ev.getCoalescedEvents = () =>
			coalesced.map((cts) => ({ ...base, timeStamp: cts }) as unknown as PointerEvent);
	}
	return ev as unknown as PointerEvent;
}

// ---- recorder --------------------------------------------------------------

export function recorder() {
	const rawCalls: PenSample[][] = [];
	const moveCounts: number[] = [];
	let downs = 0;
	let ups = 0;
	const cb: InlinePenCallbacks = {
		onPenDown: () => void downs++,
		onPenHover: () => {},
		onPenLeave: () => {},
		onPinch: () => {},
		onPenRaw: (samples) => void rawCalls.push(samples),
		onPenMove: (_ev, n) => void moveCounts.push(n),
		onPenUp: () => void ups++,
	};
	return {
		cb,
		rawCalls,
		moveCounts,
		get downs() {
			return downs;
		},
		get ups() {
			return ups;
		},
	};
}

export function harness() {
	const el = fakeEl();
	const rec = recorder();
	const router = new InlinePenRouter(
		el as unknown as HTMLElement,
		el as unknown as HTMLElement,
		rec.cb
	);
	const fire = (ev: PointerEvent) => {
		const h = el.handlers.get(ev.type);
		if (!h) throw new Error(`router registered no handler for ${ev.type}`);
		h(ev);
	};
	const fireWin = (ev: PointerEvent) => {
		const h = winHandlers.get(ev.type);
		if (!h) throw new Error(`router registered no window handler for ${ev.type}`);
		h(ev);
	};
	return { router, rec, fire, fireWin, el };
}

/** Flatten every fed sample's timestamp, across calls, in delivery order. */
export function fedTimestamps(rawCalls: PenSample[][]): number[] {
	return rawCalls.flat().map((s) => s.timestamp);
}
