/**
 * A second window for tests: the popout Obsidian opens with "Move to new
 * window", as its own object with its own document, listeners, clock, frames
 * and timers, and a close that fires what a closing browser window fires.
 *
 * The popout defects (audit items 56-61 and friends) all have one shape: code
 * reaches for the global `window`, `document`, `performance` or a module-level
 * list where it should have used the window the element lives in, or it keeps
 * hold of a window after that window is gone. A test can only see that if the
 * second window is a separate object whose every door is counted. This is
 * that object. No jsdom, same as every other fake here; the approach is the
 * second-document one from src/slides/SlidesPopout.test.ts on the CX7 branch,
 * pulled out so every popout cell uses one copy instead of each growing its own.
 *
 * Listeners follow the browser's rules: a listener is the pair (function,
 * capture), a second add of the same pair is ignored, remove must name the same
 * capture, `once` removes itself before it runs, and one removed during a
 * dispatch does not run later in that dispatch. Each matchMedia call returns a
 * NEW list with its own listeners, as a browser does, so a remove through a
 * fresh list for the same query removes nothing.
 *
 * What it counts, so a cell can assert on it:
 * - `listeners(type)`: live window listeners of that type, added minus removed.
 * - `documentListeners(type)`: the same for the document.
 * - `mediaListeners(query)`: live "change" listeners summed over every list
 *   matchMedia(query) ever returned.
 * - `calls`: every add/removeEventListener on the window, its document and its
 *   media lists, in order, including after close. A module that still holds
 *   the window shows up here the moment it touches it.
 * - `document.hidden` / `visibilityState`: this window's, set with `setHidden`.
 * - `dispatch` / `dispatchDocument`: fire an event at the window's or the
 *   document's own listeners.
 * - `performance.now()` and requestAnimationFrame timestamps: this window's
 *   clock, which starts wherever the cell puts it and never reads the global.
 * - timers: setTimeout/clearTimeout queued on this window only; `advance`
 *   runs the timers that come due. Frames run only when a cell calls `frame`.
 *
 * `close()` fires beforeunload, pagehide and unload on the window in that order
 * (the order a browser window fires them), then marks it closed. A frame or
 * timer that comes due after close does not run, as in a real closed window.
 */

export type Listener = (ev: { type: string; [k: string]: unknown }) => void;
type ListenerOptions = boolean | { capture?: boolean; once?: boolean };
interface Entry {
	fn: Listener;
	capture: boolean;
	once: boolean;
}

export interface PopoutCall {
	op: "add" | "remove";
	/** "window", "document", or "media:<query>". */
	target: string;
	type: string;
	afterClose: boolean;
}

export interface PopoutWindowOptions {
	/** Where this window's performance clock starts, ms. Default 0. */
	clockStart?: number;
	/** The window's document starts hidden. Default false. */
	hidden?: boolean;
	/** getComputedStyle's answer for position. Default "static". */
	position?: string;
	devicePixelRatio?: number;
}

export interface PopoutWindow {
	readonly window: Window;
	readonly document: Document & { defaultView: Window };
	readonly calls: PopoutCall[];
	listeners(type: string): number;
	documentListeners(type: string): number;
	mediaListeners(query: string): number;
	/** Fire an event at the window's listeners, the way the browser would. */
	dispatch(type: string, extra?: Record<string, unknown>): void;
	/** Fire an event at the document's listeners only (a capture-phase tracer's view of it). */
	dispatchDocument(type: string, extra?: Record<string, unknown>): void;
	setHidden(hidden: boolean): void;
	/** Advance this window's clock, running the timers that come due (not frames). */
	advance(ms: number): void;
	/** Run one frame at the current clock: every queued rAF callback, once. */
	frame(): void;
	pendingFrames(): number;
	pendingTimers(): number;
	close(): void;
	readonly closed: boolean;
}

export function makePopoutWindow(opts: PopoutWindowOptions = {}): PopoutWindow {
	let clock = opts.clockStart ?? 0;
	let hidden = opts.hidden ?? false;
	let closed = false;
	const calls: PopoutCall[] = [];
	const winListeners = new Map<string, Entry[]>();
	const docListeners = new Map<string, Entry[]>();
	/** Every list matchMedia returned, each with its own "change" listeners. */
	const mediaLists: Array<{ query: string; listeners: Map<string, Entry[]> }> = [];
	let nextId = 1;
	const frames = new Map<number, (t: number) => void>();
	const timers: Array<{ id: number; at: number; fn: () => void }> = [];

	const captureOf = (o?: ListenerOptions): boolean => (typeof o === "boolean" ? o : !!o?.capture);
	const add = (map: Map<string, Entry[]>, key: string, fn: Listener, o?: ListenerOptions): void => {
		const list = map.get(key) ?? [];
		const capture = captureOf(o);
		if (list.some((e) => e.fn === fn && e.capture === capture)) return;
		list.push({ fn, capture, once: typeof o === "object" && !!o?.once });
		map.set(key, list);
	};
	const remove = (map: Map<string, Entry[]>, key: string, fn: Listener, o?: ListenerOptions): void => {
		const list = map.get(key);
		const capture = captureOf(o);
		const i = list ? list.findIndex((e) => e.fn === fn && e.capture === capture) : -1;
		if (list && i >= 0) list.splice(i, 1);
	};
	const fire = (map: Map<string, Entry[]>, type: string, ev: { type: string; [k: string]: unknown }): void => {
		const list = map.get(type);
		if (!list) return;
		for (const e of [...list]) {
			if (!list.includes(e)) continue;
			if (e.once) list.splice(list.indexOf(e), 1);
			e.fn(ev);
		}
	};
	const count = (map: Map<string, Entry[]>, type: string): number => map.get(type)?.length ?? 0;

	const mediaList = (query: string) => {
		const listeners = new Map<string, Entry[]>();
		mediaLists.push({ query, listeners });
		return {
			media: query,
			matches: false,
			addEventListener(type: string, fn: Listener, o?: ListenerOptions): void {
				calls.push({ op: "add", target: `media:${query}`, type, afterClose: closed });
				add(listeners, type, fn, o);
			},
			removeEventListener(type: string, fn: Listener, o?: ListenerOptions): void {
				calls.push({ op: "remove", target: `media:${query}`, type, afterClose: closed });
				remove(listeners, type, fn, o);
			},
		};
	};

	const doc = {
		get hidden(): boolean {
			return hidden;
		},
		get visibilityState(): string {
			return hidden ? "hidden" : "visible";
		},
		defaultView: null as unknown as Window,
		addEventListener(type: string, fn: Listener, o?: ListenerOptions): void {
			calls.push({ op: "add", target: "document", type, afterClose: closed });
			add(docListeners, type, fn, o);
		},
		removeEventListener(type: string, fn: Listener, o?: ListenerOptions): void {
			calls.push({ op: "remove", target: "document", type, afterClose: closed });
			remove(docListeners, type, fn, o);
		},
		body: {},
		documentElement: {},
	};

	const win = {
		document: doc,
		get closed(): boolean {
			return closed;
		},
		devicePixelRatio: opts.devicePixelRatio ?? 1,
		performance: { now: () => clock },
		addEventListener(type: string, fn: Listener, o?: ListenerOptions): void {
			calls.push({ op: "add", target: "window", type, afterClose: closed });
			add(winListeners, type, fn, o);
		},
		removeEventListener(type: string, fn: Listener, o?: ListenerOptions): void {
			calls.push({ op: "remove", target: "window", type, afterClose: closed });
			remove(winListeners, type, fn, o);
		},
		matchMedia: (query: string) => mediaList(query),
		getComputedStyle: () => ({ position: opts.position ?? "static" }),
		requestAnimationFrame(fn: (t: number) => void): number {
			const id = nextId++;
			frames.set(id, fn);
			return id;
		},
		cancelAnimationFrame(id: number): void {
			frames.delete(id);
		},
		setTimeout(fn: () => void, ms = 0): number {
			const id = nextId++;
			timers.push({ id, at: clock + ms, fn });
			return id;
		},
		clearTimeout(id: number): void {
			const i = timers.findIndex((t) => t.id === id);
			if (i >= 0) timers.splice(i, 1);
		},
	};
	doc.defaultView = win as unknown as Window;

	function dispatch(type: string, extra: Record<string, unknown> = {}): void {
		fire(winListeners, type, { type, ...extra });
	}

	function dispatchDocument(type: string, extra: Record<string, unknown> = {}): void {
		fire(docListeners, type, { type, ...extra });
	}

	function frame(): void {
		if (closed) return;
		const due = [...frames.entries()];
		frames.clear();
		for (const [, fn] of due) fn(clock);
	}

	function advance(ms: number): void {
		const until = clock + ms;
		for (;;) {
			if (closed) break;
			const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			clock = due.at;
			win.clearTimeout(due.id);
			due.fn();
		}
		clock = until;
	}

	return {
		window: win as unknown as Window,
		document: doc as unknown as Document & { defaultView: Window },
		calls,
		listeners: (type) => count(winListeners, type),
		documentListeners: (type) => count(docListeners, type),
		mediaListeners: (query) =>
			mediaLists.filter((l) => l.query === query).reduce((n, l) => n + count(l.listeners, "change"), 0),
		dispatch,
		dispatchDocument,
		setHidden(h: boolean): void {
			hidden = h;
			// Fired at the document with bubbles, so the window hears it second.
			fire(docListeners, "visibilitychange", { type: "visibilitychange" });
			fire(winListeners, "visibilitychange", { type: "visibilitychange" });
		},
		advance,
		frame,
		pendingFrames: () => frames.size,
		pendingTimers: () => timers.length,
		close(): void {
			if (closed) return;
			dispatch("beforeunload");
			dispatch("pagehide");
			dispatch("unload");
			closed = true;
		},
		get closed(): boolean {
			return closed;
		},
	};
}
