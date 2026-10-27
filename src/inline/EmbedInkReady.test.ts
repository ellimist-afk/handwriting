/**
 * The three routes to a rendered root, and the wait that covers the third.
 *
 * Samuel (1.4.11, an environment nobody here can see) embeds an inked note
 * and gets no ink; the eight-case matrix on this machine passes 8/8. So the
 * fix cannot be justified by a green run - only by the routes it covers - and
 * these are the tests for the routes and the policy, which are pure, plus the
 * teardown of the two things the wait leaves running, which is the part that
 * would otherwise leak into a reload.
 *
 * No jsdom in this suite (see EmbedInk.test.ts), so the fakes are the smallest
 * objects the code actually touches: `closest` for the root walk, a virtual
 * clock and timer queue for the poll, and recorded MutationObserver and
 * ResizeObserver instances so a test can fire them and then assert they were
 * disconnected.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EMBED_INK_WAIT_MS,
	attachEmbedInk,
	attachEmbedInkOnceReady,
	disarmPrintSwaps,
	embedInkDiagLine,
	embedInkIsCollapsed,
	embedInkKeepWaiting,
	embedInkChanged,
	embedInkPendingWaitCount,
	embedInkRenamed,
	embedInkResolveRoot,
	embedInkRetryDelay,
	embedInkSizeWatchCount,
	initEmbedInkDiagnostics,
	initEmbedInkRefresh,
	teardownEmbedInk,
} from "./EmbedInk";
import { InkStroke } from "../ink/Stroke";

afterEach(() => {
	teardownEmbedInk();
	disarmPrintSwaps();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------- pure order

/** The one DOM method the root walk calls, over a fake parent chain. */
function fakeNode(cls: string | null, parent: { closest(sel: string): unknown } | null = null) {
	const node = {
		closest(sel: string): unknown {
			const wanted = sel.replace(/^\./, "");
			return cls === wanted ? node : (parent?.closest(sel) ?? null);
		},
	};
	return node;
}

const asEl = (n: unknown) => n as unknown as HTMLElement;

describe("embedInkResolveRoot: which of the three routes found the root", () => {
	it("route 1, the section is in the tree: via section, and the container is ignored", () => {
		const embedContent = fakeNode("markdown-embed-content");
		const attached = fakeNode(null, embedContent);
		const otherContainer = fakeNode("markdown-preview-sizer");
		expect(embedInkResolveRoot(asEl(attached), asEl(otherContainer))).toEqual({
			root: embedContent,
			via: "section",
		});
	});

	it("route 2, the section is detached but the renderer gave a container: via container", () => {
		const embedContent = fakeNode("markdown-embed-content");
		const sizer = fakeNode("markdown-preview-sizer", embedContent);
		const detached = fakeNode(null);
		expect(embedInkResolveRoot(asEl(detached), asEl(sizer))).toEqual({
			root: embedContent,
			via: "container",
		});
	});

	it("route 3, neither: no root and via none, which is what the wait is for", () => {
		const detached = fakeNode(null);
		expect(embedInkResolveRoot(asEl(detached), null)).toEqual({ root: null, via: "none" });
		expect(embedInkResolveRoot(asEl(detached), undefined)).toEqual({ root: null, via: "none" });
	});
});

// --------------------------------------------------------------- retry policy

describe("the retry policy is bounded by TIME, not by frames", () => {
	it("waits a full ten seconds of wall clock", () => {
		expect(EMBED_INK_WAIT_MS).toBe(10_000);
		expect(embedInkKeepWaiting(0)).toBe(true);
		expect(embedInkKeepWaiting(EMBED_INK_WAIT_MS - 1)).toBe(true);
		expect(embedInkKeepWaiting(EMBED_INK_WAIT_MS)).toBe(false);
		expect(embedInkKeepWaiting(60_000)).toBe(false);
	});

	it("thirty ticks no longer exhaust the budget", () => {
		// The bound this replaces was 30 FRAMES - about half a second on a
		// machine running at 60Hz, and rather less than that on one that is
		// backgrounded, throttled, or simply slow, which is exactly the
		// machine whose section is late. Thirty of these ticks are still
		// early in the wait.
		let elapsed = 0;
		for (let i = 0; i < 30; i++) elapsed += embedInkRetryDelay(elapsed);
		expect(elapsed).toBeLessThan(EMBED_INK_WAIT_MS);
		expect(embedInkKeepWaiting(elapsed)).toBe(true);
	});

	it("checks tightly at first and loosens off, never stalling", () => {
		expect(embedInkRetryDelay(0)).toBe(16);
		expect(embedInkRetryDelay(249)).toBe(16);
		expect(embedInkRetryDelay(250)).toBe(50);
		expect(embedInkRetryDelay(999)).toBe(50);
		expect(embedInkRetryDelay(1_000)).toBe(250);
		expect(embedInkRetryDelay(9_000)).toBe(250);
		let last = 0;
		for (let t = 0; t <= EMBED_INK_WAIT_MS; t += 37) {
			const d = embedInkRetryDelay(t);
			expect(d).toBeGreaterThan(0);
			expect(d).toBeGreaterThanOrEqual(last);
			last = d;
		}
	});

	it("costs a bounded number of wake-ups and always terminates", () => {
		let elapsed = 0;
		let wakeUps = 0;
		while (embedInkKeepWaiting(elapsed)) {
			elapsed += embedInkRetryDelay(elapsed);
			wakeUps++;
			expect(wakeUps).toBeLessThan(500); // a stalled schedule would spin here
		}
		expect(wakeUps).toBeLessThan(100);
		expect(elapsed).toBeGreaterThanOrEqual(EMBED_INK_WAIT_MS);
	});
});

// ------------------------------------------------------------- the diagnostic

describe("embedInkDiagLine", () => {
	it("is one line naming the route, the wait and the note", () => {
		expect(embedInkDiagLine("section", "note.md", 0)).toBe(
			"[handwriting] embed ink root via section after 0ms: note.md"
		);
		expect(embedInkDiagLine("container", "a/b.md", 0)).toBe(
			"[handwriting] embed ink root via container after 0ms: a/b.md"
		);
		expect(embedInkDiagLine("observer", "note.md", 812)).toBe(
			"[handwriting] embed ink root via observer after 812ms: note.md"
		);
		expect(embedInkDiagLine("timer", "note.md", 32)).toBe(
			"[handwriting] embed ink root via timer after 32ms: note.md"
		);
	});

	it("says `none` when the wait ran out, which is the report worth having", () => {
		expect(embedInkDiagLine("none", "note.md", 10_002)).toBe(
			"[handwriting] embed ink root via none after 10002ms: note.md"
		);
	});
});

// ------------------------------------------------------------------ the wait

interface FakeObserver {
	target: unknown;
	options: unknown;
	disconnected: boolean;
	fire(): void;
}

/** A virtual clock, timer queue and observer factory, all recorded. */
function fakeEnv() {
	let clock = 1_000_000;
	vi.spyOn(Date, "now").mockImplementation(() => clock);
	const timers: Array<{ id: number; at: number; fn: () => void }> = [];
	let nextId = 1;
	const mutation: FakeObserver[] = [];

	class FakeMutationObserver {
		record: FakeObserver | null = null;
		constructor(private readonly cb: () => void) {}
		observe(target: unknown, options: unknown): void {
			this.record = { target, options, disconnected: false, fire: () => this.cb() };
			mutation.push(this.record);
		}
		disconnect(): void {
			if (this.record) this.record.disconnected = true;
		}
	}

	const view = {
		setTimeout(fn: () => void, ms: number): number {
			const id = nextId++;
			timers.push({ id, at: clock + ms, fn });
			return id;
		},
		clearTimeout(id: number): void {
			const i = timers.findIndex((t) => t.id === id);
			if (i >= 0) timers.splice(i, 1);
		},
		MutationObserver: FakeMutationObserver,
		addEventListener(): void {},
		removeEventListener(): void {},
		getComputedStyle: () => ({ position: "static" }),
		devicePixelRatio: 1,
	};

	/** Advance the clock, firing whatever comes due, one timer at a time. */
	function advance(ms: number): void {
		const until = clock + ms;
		for (;;) {
			const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			clock = due.at;
			view.clearTimeout(due.id);
			due.fn();
		}
		clock = until;
	}

	return { view, mutation, advance, pendingTimers: () => timers.length };
}

/** The smallest root `attachEmbedInk` + `paint` touch with zero strokes. */
function fakeRoot(view: unknown) {
	const attrs = new Map<string, string>();
	return {
		isConnected: true,
		classList: { contains: () => false },
		style: { position: "", removeProperty(): void {} },
		querySelector: () => null,
		getAttribute: (k: string) => attrs.get(k) ?? null,
		setAttribute: (k: string, v: string) => void attrs.set(k, v),
		removeAttribute: (k: string) => void attrs.delete(k),
		ownerDocument: { defaultView: view },
	};
}

/** A section element whose parent chain the test can rewire mid-wait. */
function fakeSection(view: unknown, body: unknown) {
	let parent: { closest(sel: string): unknown } | null = null;
	return {
		closest(sel: string): unknown {
			return parent?.closest(sel) ?? null;
		},
		connectTo(p: { closest(sel: string): unknown }): void {
			parent = p;
		},
		isConnected: false,
		ownerDocument: { defaultView: view, body },
	};
}

/** The parent chain a section gains when the renderer finally inserts it. */
function parentWith(root: unknown) {
	return { closest: (sel: string) => (sel === ".markdown-embed-content" ? root : null) };
}

function recordDiagnostics(): Array<[string, string, number]> {
	const lines: Array<[string, string, number]> = [];
	initEmbedInkDiagnostics((via, path, waitedMs) => lines.push([via, path, waitedMs]));
	return lines;
}

const noStrokes = (): readonly InkStroke[] => [];

describe("attachEmbedInkOnceReady: route 1 and 2 stay synchronous", () => {
	it("attaches on the spot from an attached section and waits for nothing", () => {
		const env = fakeEnv();
		const lines = recordDiagnostics();
		const root = fakeRoot(env.view);
		const section = fakeSection(env.view, {});
		section.connectTo(parentWith(root));

		const cancel = attachEmbedInkOnceReady(asEl(section), null, "note.md", noStrokes);

		expect(lines).toEqual([["section", "note.md", 0]]);
		expect(embedInkPendingWaitCount()).toBe(0);
		expect(env.pendingTimers()).toBe(0);
		expect(env.mutation).toHaveLength(0);
		cancel();
	});

	it("attaches on the spot from the renderer's container", () => {
		const env = fakeEnv();
		const lines = recordDiagnostics();
		const root = fakeRoot(env.view);
		const section = fakeSection(env.view, {});

		attachEmbedInkOnceReady(asEl(section), asEl(parentWith(root)), "note.md", noStrokes);

		expect(lines).toEqual([["container", "note.md", 0]]);
		expect(embedInkPendingWaitCount()).toBe(0);
		expect(env.pendingTimers()).toBe(0);
	});
});

describe("attachEmbedInkOnceReady: route 3, no container and a section not yet in the tree", () => {
	it("arms BOTH the observer and the poll, on the section's own window", () => {
		const env = fakeEnv();
		const body = { tag: "body" };
		const section = fakeSection(env.view, body);

		attachEmbedInkOnceReady(asEl(section), null, "note.md", noStrokes);

		expect(embedInkPendingWaitCount()).toBe(1);
		expect(env.pendingTimers()).toBe(1);
		expect(env.mutation).toHaveLength(1);
		expect(env.mutation[0]?.target).toBe(body);
		expect(env.mutation[0]?.options).toEqual({ childList: true, subtree: true });
	});

	it("the observer catches the section landing, and then disconnects", () => {
		const env = fakeEnv();
		const lines = recordDiagnostics();
		const root = fakeRoot(env.view);
		const section = fakeSection(env.view, {});

		attachEmbedInkOnceReady(asEl(section), null, "note.md", noStrokes);
		env.advance(120); // the renderer takes its time
		expect(lines).toEqual([]);

		section.connectTo(parentWith(root));
		env.mutation[0]?.fire();

		expect(lines).toEqual([["observer", "note.md", 120]]);
		expect(env.mutation[0]?.disconnected).toBe(true);
		expect(env.pendingTimers()).toBe(0);
		expect(embedInkPendingWaitCount()).toBe(0);
	});

	/**
	 * The observer is `body` + `subtree`, so it runs on every mutation
	 * Obsidian makes anywhere. A reading-view note with N unresolved embeds
	 * used to install N of them, each re-resolving its own section on every
	 * one of those mutations for up to ten seconds. One per document now,
	 * shared by the waits and disconnected as the last of them goes.
	 */
	it("waits on the same document share ONE observer, disconnected by the last cancel", () => {
		const env = fakeEnv();
		const body = { tag: "body" };
		const first = fakeSection(env.view, body);
		const second = fakeSection(env.view, body);

		const cancelFirst = attachEmbedInkOnceReady(asEl(first), null, "one.md", noStrokes);
		const cancelSecond = attachEmbedInkOnceReady(asEl(second), null, "two.md", noStrokes);

		expect(embedInkPendingWaitCount()).toBe(2);
		expect(env.mutation, "one observer per section is the cost being fixed").toHaveLength(1);
		expect(env.mutation[0]?.target).toBe(body);
		expect(env.pendingTimers(), "each wait still polls for itself").toBe(2);

		cancelFirst();
		expect(
			env.mutation[0]?.disconnected,
			"the second wait was left with no observer"
		).toBe(false);

		cancelSecond();
		expect(env.mutation[0]?.disconnected).toBe(true);
		expect(embedInkPendingWaitCount()).toBe(0);
	});

	it("the shared observer still resolves each section on its own", () => {
		const env = fakeEnv();
		const lines = recordDiagnostics();
		const body = { tag: "body" };
		const rootOne = fakeRoot(env.view);
		const rootTwo = fakeRoot(env.view);
		const first = fakeSection(env.view, body);
		const second = fakeSection(env.view, body);

		attachEmbedInkOnceReady(asEl(first), null, "one.md", noStrokes);
		attachEmbedInkOnceReady(asEl(second), null, "two.md", noStrokes);

		// The renderer inserts one section; the shared callback must settle
		// that one and leave the other waiting.
		env.advance(120);
		first.connectTo(parentWith(rootOne));
		env.mutation[0]?.fire();

		expect(lines).toEqual([["observer", "one.md", 120]]);
		expect(embedInkPendingWaitCount()).toBe(1);
		expect(env.mutation[0]?.disconnected, "the other wait still needs it").toBe(false);

		second.connectTo(parentWith(rootTwo));
		env.mutation[0]?.fire();

		expect(lines).toEqual([
			["observer", "one.md", 120],
			["observer", "two.md", 120],
		]);
		expect(embedInkPendingWaitCount()).toBe(0);
		expect(env.mutation[0]?.disconnected).toBe(true);
	});

	it("the poll catches it where there is no MutationObserver at all", () => {
		// A renderer that batches its DOM insertion somewhere `body` never
		// sees, or a host with no MutationObserver: the braces, not the belt.
		const env = fakeEnv();
		const viewWithoutMO = { ...env.view, MutationObserver: undefined };
		const lines = recordDiagnostics();
		const root = fakeRoot(viewWithoutMO);
		const section = fakeSection(viewWithoutMO, {});

		attachEmbedInkOnceReady(asEl(section), null, "note.md", noStrokes);
		expect(env.mutation).toHaveLength(0);

		env.advance(500);
		expect(lines).toEqual([]);
		section.connectTo(parentWith(root));
		env.advance(200);

		expect(lines).toHaveLength(1);
		expect(lines[0]?.[0]).toBe("timer");
		expect(embedInkPendingWaitCount()).toBe(0);
	});

	it("the poll timer lands on the section's own window, not the global - the popout case", () => {
		// A popout has its own window object, and a timer scheduled on the
		// main one for an element in a popout goes on firing after that
		// popout has closed (setTimer's own doc comment). Proof that the poll
		// honours the view it was given rather than the ambient global: the
		// fake view's queue gets the timer, and the real global setTimeout is
		// never touched.
		const globalTimeout = vi.spyOn(globalThis, "setTimeout");
		const env = fakeEnv();
		const viewWithoutMO = { ...env.view, MutationObserver: undefined };
		const section = fakeSection(viewWithoutMO, {});

		attachEmbedInkOnceReady(asEl(section), null, "note.md", noStrokes);

		expect(env.pendingTimers(), "the timer landed in the section's own window's queue").toBe(1);
		expect(globalTimeout).not.toHaveBeenCalled();
	});

	it("outlasts a renderer that takes seconds, where thirty frames would not have", () => {
		const env = fakeEnv();
		const lines = recordDiagnostics();
		const root = fakeRoot(env.view);
		const section = fakeSection(env.view, {});

		attachEmbedInkOnceReady(asEl(section), null, "note.md", noStrokes);
		env.advance(6_000);
		expect(lines).toEqual([]);
		expect(embedInkPendingWaitCount()).toBe(1);

		section.connectTo(parentWith(root));
		env.advance(300);

		expect(lines).toHaveLength(1);
		expect(lines[0]?.[0]).toBe("timer");
		expect(lines[0]?.[2]).toBeGreaterThanOrEqual(6_000);
	});

	it("gives up at the budget, says so once, and leaves nothing running", () => {
		const env = fakeEnv();
		const lines = recordDiagnostics();
		const section = fakeSection(env.view, {});

		attachEmbedInkOnceReady(asEl(section), null, "note.md", noStrokes);
		env.advance(EMBED_INK_WAIT_MS + 1_000);

		expect(lines).toHaveLength(1);
		expect(lines[0]?.[0]).toBe("none");
		expect(lines[0]?.[2]).toBeGreaterThanOrEqual(EMBED_INK_WAIT_MS);
		expect(env.pendingTimers()).toBe(0);
		expect(env.mutation[0]?.disconnected).toBe(true);
		expect(embedInkPendingWaitCount()).toBe(0);
	});
});

describe("a wait never outlives what started it", () => {
	it("the render child's canceller stops the poll and the observer", () => {
		const env = fakeEnv();
		const lines = recordDiagnostics();
		const root = fakeRoot(env.view);
		const section = fakeSection(env.view, {});

		const cancel = attachEmbedInkOnceReady(asEl(section), null, "note.md", noStrokes);
		cancel();

		expect(env.pendingTimers()).toBe(0);
		expect(env.mutation[0]?.disconnected).toBe(true);
		expect(embedInkPendingWaitCount()).toBe(0);

		// And nothing it left behind can still fire: the section landing now
		// must not paint into a view whose child has gone.
		section.connectTo(parentWith(root));
		env.mutation[0]?.fire();
		env.advance(EMBED_INK_WAIT_MS);
		expect(lines).toEqual([]);
	});

	it("cancelling twice is harmless", () => {
		const env = fakeEnv();
		const section = fakeSection(env.view, {});
		const cancel = attachEmbedInkOnceReady(asEl(section), null, "note.md", noStrokes);
		cancel();
		cancel();
		expect(embedInkPendingWaitCount()).toBe(0);
	});

	it("plugin unload cancels a wait the render child never unloaded", () => {
		// A MarkdownRenderChild belongs to the markdown view's component tree,
		// not to the plugin, so disabling the plugin does NOT unload it. A
		// pending timer would then go on calling into a module the next enable
		// has already replaced.
		const env = fakeEnv();
		const lines = recordDiagnostics();
		const root = fakeRoot(env.view);
		const section = fakeSection(env.view, {});

		attachEmbedInkOnceReady(asEl(section), null, "note.md", noStrokes);
		expect(embedInkPendingWaitCount()).toBe(1);

		teardownEmbedInk();

		expect(embedInkPendingWaitCount()).toBe(0);
		expect(env.pendingTimers()).toBe(0);
		expect(env.mutation[0]?.disconnected).toBe(true);

		section.connectTo(parentWith(root));
		env.mutation[0]?.fire();
		env.advance(EMBED_INK_WAIT_MS);
		expect(lines).toEqual([]);
	});

	it("teardown silences the diagnostic sink as well", () => {
		const env = fakeEnv();
		const lines = recordDiagnostics();
		const root = fakeRoot(env.view);
		const section = fakeSection(env.view, {});
		section.connectTo(parentWith(root));
		teardownEmbedInk();
		attachEmbedInkOnceReady(asEl(section), null, "note.md", noStrokes);
		expect(lines).toEqual([]);
	});
});

// ------------------------------------------------- the zero-size re-measure

describe("embedInkIsCollapsed", () => {
	it("a box with no width or no height has not been laid out", () => {
		expect(embedInkIsCollapsed({ width: 0, height: 0 })).toBe(true);
		expect(embedInkIsCollapsed({ width: 300, height: 0 })).toBe(true);
		expect(embedInkIsCollapsed({ width: 0, height: 368 })).toBe(true);
	});

	it("any real box is fine, however short", () => {
		// The 1.4.11 clip case: 24px of box against 368px of ink. That is a
		// clip, which min-height fixes; it is not a collapse.
		expect(embedInkIsCollapsed({ width: 285, height: 24 })).toBe(false);
		expect(embedInkIsCollapsed(null)).toBe(false);
	});
});

function strokeWithBBox(x: number, y: number, width: number, height: number): InkStroke {
	return {
		id: "s",
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [],
		bbox: { x, y, width, height },
	} as unknown as InkStroke;
}

/** An embed root that can be laid out on demand, with a ResizeObserver. */
function fakeSizedRoot() {
	const attrs = new Map<string, string>();
	const canvases: Array<Record<string, unknown>> = [];
	const resize: FakeObserver[] = [];
	let rect = { width: 0, height: 0 };

	class FakeResizeObserver {
		record: FakeObserver | null = null;
		constructor(private readonly cb: () => void) {}
		observe(target: unknown): void {
			this.record = { target, options: null, disconnected: false, fire: () => this.cb() };
			resize.push(this.record);
		}
		disconnect(): void {
			if (this.record) this.record.disconnected = true;
		}
	}

	const style = { position: "static", minHeight: "", removeProperty(): void {} };
	const root = {
		canvases,
		resize,
		layOut(w: number, h: number): void {
			rect = { width: w, height: h };
		},
		isConnected: true,
		classList: { contains: (c: string) => c === "markdown-embed-content" },
		style,
		setCssStyles(styles: Record<string, string>): void {
			if ("position" in styles) style.position = styles.position ?? "";
			if ("minHeight" in styles) style.minHeight = styles.minHeight ?? "";
		},
		getBoundingClientRect: () => rect,
		querySelector: () => null,
		getAttribute: (k: string) => attrs.get(k) ?? null,
		setAttribute: (k: string, v: string) => void attrs.set(k, v),
		removeAttribute: (k: string) => void attrs.delete(k),
		createEl: () => {
			const canvas = {
				style: {} as Record<string, string>,
				width: 0,
				height: 0,
				setCssStyles(this: { style: Record<string, string> }, s: Record<string, string>) {
					Object.assign(this.style, s);
				},
				getContext: () => ({ setTransform() {}, clearRect() {}, globalAlpha: 1 }),
				remove() {},
			};
			canvases.push(canvas);
			return canvas;
		},
		ownerDocument: {
			defaultView: {
				addEventListener() {},
				removeEventListener() {},
				getComputedStyle: () => ({ position: "static" }),
				devicePixelRatio: 1,
				ResizeObserver: FakeResizeObserver,
			},
		},
	};
	return root;
}

/** Attach with a live stroke provider, the way the plugin wires it at load. */
function attachWithInk(root: unknown, strokes: readonly InkStroke[]): void {
	initEmbedInkRefresh(() => strokes);
	attachEmbedInk(root as unknown as HTMLElement, "note.md", strokes);
}

describe("a painted root with no size is re-measured, not abandoned at 0x0", () => {
	it("watches a collapsed embed and repaints it the moment layout gives it a size", () => {
		const root = fakeSizedRoot();
		attachWithInk(root, [strokeWithBBox(0, 0, 285, 368)]);

		// Drawn, but into a box measuring nothing: watched rather than left.
		expect(root.canvases).toHaveLength(1);
		expect(embedInkSizeWatchCount()).toBe(1);
		expect(root.resize[0]?.target).toBe(root);

		// A tick while it is still collapsed changes nothing.
		root.resize[0]?.fire();
		expect(root.canvases).toHaveLength(1);
		expect(embedInkSizeWatchCount()).toBe(1);

		// The theme, the callout or the pane finally lays it out.
		root.layOut(285, 24);
		root.resize[0]?.fire();

		expect(root.canvases).toHaveLength(2); // re-measured and painted again
		expect(root.style.minHeight).toBe("368px");
		expect(embedInkSizeWatchCount()).toBe(0);
		expect(root.resize[0]?.disconnected).toBe(true);
	});

	it("a root that already has a size is never watched", () => {
		const root = fakeSizedRoot();
		root.layOut(285, 24);
		attachWithInk(root, [strokeWithBBox(0, 0, 285, 368)]);

		expect(root.canvases).toHaveLength(1);
		expect(embedInkSizeWatchCount()).toBe(0);
		expect(root.resize).toHaveLength(0);
	});

	it("a collapsed root that left the DOM is swept by the next paint", () => {
		// The watches used to be swept only from `attachEmbedInk` and
		// `embedInkChanged`, so a root that collapsed and then left the tree
		// held its ResizeObserver until the next embed render or the next
		// persisted gesture anywhere - never, in a session that only reads.
		const gone = fakeSizedRoot();
		const kept = fakeSizedRoot();
		attachWithInk(gone, [strokeWithBBox(0, 0, 285, 368)]);
		attachWithInk(kept, [strokeWithBBox(0, 0, 285, 368)]);
		expect(embedInkSizeWatchCount()).toBe(2);

		// The embed collapses, or its pane closes: the root leaves the tree
		// with no notification of any kind, its own observer included.
		gone.isConnected = false;

		// A paint that goes through neither of the old sweep sites: the OTHER
		// root's resize callback, repainting itself.
		kept.layOut(285, 24);
		kept.resize[0]?.fire();

		expect(gone.resize[0]?.disconnected, "a ResizeObserver on a detached tree").toBe(true);
		expect(embedInkSizeWatchCount()).toBe(0);
	});

	it("a collapsed root that left the DOM is swept by a change notification of another note, with no paint", () => {
		// The notification sweep is the one that runs when no paint does: a note's ink was saved, and no root shows it.
		const gone = fakeSizedRoot();
		attachWithInk(gone, [strokeWithBBox(0, 0, 285, 368)]);
		expect(embedInkSizeWatchCount()).toBe(1);

		gone.isConnected = false;
		embedInkChanged("another-note.md");

		expect(gone.resize[0]?.disconnected, "a ResizeObserver on a detached tree").toBe(true);
		expect(embedInkSizeWatchCount()).toBe(0);
	});

	it("a root that has already left the DOM is never armed with a watch", () => {
		// It measures 0x0 like a collapsed root, and it will never gain a size.
		const root = fakeSizedRoot();
		root.isConnected = false;

		attachWithInk(root, [strokeWithBBox(0, 0, 285, 368)]);

		expect(embedInkSizeWatchCount()).toBe(0);
		expect(root.resize).toHaveLength(0);
	});

	it("unload disconnects a size observer that never fired", () => {
		const root = fakeSizedRoot();
		attachWithInk(root, [strokeWithBBox(0, 0, 285, 368)]);
		expect(embedInkSizeWatchCount()).toBe(1);

		teardownEmbedInk();

		expect(embedInkSizeWatchCount()).toBe(0);
		expect(root.resize[0]?.disconnected).toBe(true);

		// And a late tick from it cannot repaint through a dead module.
		root.layOut(285, 24);
		root.resize[0]?.fire();
		expect(root.canvases).toHaveLength(1);
	});
});

describe("attachEmbedInkOnceReady: a rename while the embed waits for its section", () => {
	it("the late attach registers the root under the renamed note", () => {
		const env = fakeEnv();
		const root = fakeRoot(env.view);
		const section = fakeSection(env.view, {});
		const asked: string[] = [];
		initEmbedInkRefresh((p) => {
			asked.push(p);
			return [];
		});

		attachEmbedInkOnceReady(asEl(section), null, "old.md", noStrokes);
		env.advance(120);
		embedInkRenamed("old.md", "new.md"); // the vault renamed the note while the embed waited
		section.connectTo(parentWith(root));
		env.mutation[0]?.fire();
		expect(embedInkPendingWaitCount(), "premise: the wait ended with an attach").toBe(0);

		asked.length = 0;
		embedInkChanged("new.md");
		expect(asked, "a change to the renamed note reaches the embed that waited").toEqual(["new.md"]);
	});
});
