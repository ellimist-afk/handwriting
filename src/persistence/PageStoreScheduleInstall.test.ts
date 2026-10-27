/**
 * The page store's save scheduling (the quiet-period and maximum-dirty timers, the pen watch,
 * the immediate and background flushes, the move of a file aside under a new id) lives in
 * PageStoreSchedule.ts and is installed on PageStore.prototype when PageStore.ts loads. Four
 * things a type check cannot see are held here, as the install tests of the other split files
 * hold them for theirs. A fifth block drives the pen watch and the save holds on a store with no
 * vault, because no other unit test reaches the pen listeners.
 *
 * LOAD ORDER. PageStore.ts imports the install function, and the new file imports values back,
 * so the two modules form a cycle. Every other test imports PageStore.ts first. This file
 * imports the new file first, so a cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the descriptor a
 * class method has. A name left out of the install still type-checks, because the interface
 * declares it, and would only fail when that path ran on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the new file
 * declares each once, so a half-finished move cannot pass with the old copy still shadowing the
 * new one.
 *
 * ONE DOOR. The new file names nothing of the store beyond the list below.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPageStoreSchedule } from "./PageStoreSchedule";
import { PageStore } from "./PageStore";
import storeRaw from "./PageStore.ts?raw";
import fileRaw from "./PageStoreSchedule.ts?raw";

const MOVED = [
	"schedule",
	"armQuiet",
	"saveUnlessPenDown",
	"saveAtBound",
	"releaseHeld",
	"watchPens",
	"unwatchPens",
	"saveNow",
	"displaceForeignBatch",
	"clearTimers",
	"flushDispatch",
	"writeTmpNow",
	"flushPage",
	"flush",
	"beginFlush",
	"flushingPage",
	"keepAsideUnder",
	"keepAsideUnderNow",
] as const;

/** Every name the new file takes from the store, and nothing else. */
const FROM_STORE = ["MAX_DIRTY_MS", "PageStore", "PageWriter", "folderOf"];

const storeSrc = storeRaw.replace(/\r\n/g, "\n");
const fileSrc = fileRaw.replace(/\r\n/g, "\n");

/** A store with no vault, as the other install tests build theirs: the prototype and the fields a method reads. */
function bareStore(fields: Record<string, unknown> = {}): PageStore {
	const store = Object.create(PageStore.prototype) as PageStore;
	for (const [key, value] of Object.entries(fields)) {
		Object.defineProperty(store, key, { value, writable: true, configurable: true });
	}
	return store;
}

/** A window that records what the pen watch and the timers ask of it, and runs nothing by itself. */
function fakeWindow() {
	const added: { type: string; capture: boolean | undefined }[] = [];
	const removed: { type: string; capture: boolean | undefined }[] = [];
	const handlers = new Map<string, (e: unknown) => void>();
	const cleared: unknown[] = [];
	const timeouts: { fn: () => void; ms: number }[] = [];
	return {
		added,
		removed,
		handlers,
		cleared,
		timeouts,
		addEventListener(type: string, fn: (e: unknown) => void, capture?: boolean) {
			added.push({ type, capture });
			handlers.set(type, fn);
		},
		removeEventListener(type: string, _fn: unknown, capture?: boolean) {
			removed.push({ type, capture });
		},
		clearTimeout(id: unknown) {
			cleared.push(id);
		},
		setTimeout(fn: () => void, ms: number) {
			timeouts.push({ fn, ms });
			return timeouts.length;
		},
	};
}

/** A step that must never run: the cell fails if the code under test reaches it. */
const neverCalled = () => {
	throw new Error("this step must not run");
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("save scheduling methods on the page store prototype", () => {
	it("loads with the new file imported first, and moved methods run on a bare store", () => {
		expect(typeof installPageStoreSchedule).toBe("function");
		const store = bareStore();
		expect(store.flushingPage("p")).toBe(false);
		const done = store.beginFlush("p");
		expect(store.flushingPage("p")).toBe(true);
		done();
		expect(store.flushingPage("p")).toBe(false);
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		for (const name of MOVED) {
			const d = Object.getOwnPropertyDescriptor(PageStore.prototype, name);
			expect(d, `${name} is not on the prototype`).toBeDefined();
			expect(typeof d!.value, name).toBe("function");
			expect(
				{ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable },
				name
			).toEqual({ writable: true, enumerable: false, configurable: true });
		}
	});

	it("each moved name is declared once in the new file and not in the class", () => {
		const classStart = storeSrc.indexOf("export class PageStore {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = storeSrc.slice(classStart, storeSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = fileSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: PageStore\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in PageStoreSchedule.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the store installs once, after the class closing brace", () => {
		const call = "installPageStoreSchedule(PageStore.prototype);";
		expect(storeSrc.split(call).length - 1).toBe(1);
		const classStart = storeSrc.indexOf("export class PageStore {");
		const classEnd = storeSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(storeSrc.indexOf(call)).toBeGreaterThan(classEnd);
	});

	it("the new file takes exactly the listed names from the store", () => {
		const imports = [...fileSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/PageStore";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_STORE].sort());
	});
});

describe("the flush bookkeeping on a bare store", () => {
	it("flushingPage is false with nothing flushing, true for any page under a whole-store flush, and per page otherwise", () => {
		expect(bareStore().flushingPage("a")).toBe(false);
		expect(bareStore({ flushing: new Map() }).flushingPage("a")).toBe(false);
		const whole = bareStore({ flushing: new Map([[null, 1]]) });
		expect(whole.flushingPage("a")).toBe(true);
		expect(whole.flushingPage("b")).toBe(true);
		const one = bareStore({ flushing: new Map([["a", 1]]) });
		expect(one.flushingPage("a")).toBe(true);
		expect(one.flushingPage("b")).toBe(false);
	});

	it("beginFlush returns an end step, nests, and wakes every parked save", () => {
		let woken = 0;
		const store = bareStore({ parked: new Set([() => woken++, () => woken++]) });
		const first = store.beginFlush("p");
		expect(typeof first).toBe("function");
		expect(woken).toBe(2);
		const second = store.beginFlush("p");
		expect(woken).toBe(4);
		first();
		expect(store.flushingPage("p")).toBe(true);
		second();
		expect(store.flushingPage("p")).toBe(false);
		expect((store as unknown as { flushing: Map<unknown, number> }).flushing.size).toBe(0);
	});
});

describe("the timer saves on a bare store", () => {
	it("saveUnlessPenDown holds the page while a pen is down and starts no write", () => {
		const store = bareStore({
			pensDown: new Set([7]),
			heldForPen: new Set<string>(),
			writePending: neverCalled,
		});
		store.saveUnlessPenDown("p", "label");
		expect((store as unknown as { heldForPen: Set<string> }).heldForPen.has("p")).toBe(true);
	});

	it("saveUnlessPenDown writes the page with the pen gate on when no pen is down", () => {
		const calls: unknown[][] = [];
		const store = bareStore({
			pensDown: new Set<number>(),
			heldForPen: new Set<string>(),
			writePending: (...args: unknown[]) => {
				calls.push(args);
				return Promise.resolve();
			},
		});
		store.saveUnlessPenDown("p", "label");
		expect(calls).toEqual([["p", true]]);
		expect((store as unknown as { heldForPen: Set<string> }).heldForPen.size).toBe(0);
	});

	it("displaceForeignBatch does nothing for no writer or the same writer, and writes a different writer's queued batch once", () => {
		const calls: unknown[][] = [];
		const writer = { who: "a" };
		const fields = {
			pending: new Map([["p", {}]]),
			pendingWriter: new Map<string, unknown>([["p", writer]]),
			writePending: (...args: unknown[]) => {
				calls.push(args);
				return Promise.resolve();
			},
		};
		const store = bareStore(fields);
		store.displaceForeignBatch("p", undefined);
		store.displaceForeignBatch("p", writer as never);
		expect(calls).toEqual([]);
		store.displaceForeignBatch("p", { who: "b" } as never);
		expect(calls).toEqual([["p"]]);
	});

	it("clearTimers clears the quiet, bound and held-cap timers and the held entry for the page", () => {
		const win = fakeWindow();
		vi.stubGlobal("window", win);
		const store = bareStore({
			timers: new Map([["p", 1]]),
			maxTimers: new Map([["p", 2]]),
			heldPastBound: new Map([["p", 3]]),
			heldForPen: new Set(["p", "q"]),
		});
		store.clearTimers("p");
		expect(win.cleared).toEqual([1, 2, 3]);
		const inner = store as unknown as {
			timers: Map<string, number>;
			maxTimers: Map<string, number>;
			heldPastBound: Map<string, number>;
			heldForPen: Set<string>;
		};
		expect(inner.timers.size + inner.maxTimers.size + inner.heldPastBound.size).toBe(0);
		expect([...inner.heldForPen]).toEqual(["q"]);
	});
});

describe("the pen watch on a bare store with a fake window", () => {
	const pen = (pointerId: number) => ({ pointerType: "pen", pointerId });
	const touch = (pointerId: number) => ({ pointerType: "touch", pointerId });

	it("watchPens registers the three pointer listeners in the capture phase and blur without it, once", () => {
		const win = fakeWindow();
		vi.stubGlobal("window", win);
		const store = bareStore({ pensDown: new Set<number>(), penWatch: null });
		store.watchPens();
		expect(win.added).toEqual([
			{ type: "pointerdown", capture: true },
			{ type: "pointerup", capture: true },
			{ type: "pointercancel", capture: true },
			{ type: "blur", capture: undefined },
		]);
		store.watchPens();
		expect(win.added.length).toBe(4);
	});

	it("unwatchPens removes the same four listeners and forgets every pen", () => {
		const win = fakeWindow();
		vi.stubGlobal("window", win);
		const store = bareStore({
			pensDown: new Set<number>(),
			penWatch: null,
			heldForPen: new Set<string>(),
			heldPastBound: new Map<string, number>(),
		});
		store.watchPens();
		win.handlers.get("pointerdown")!(pen(1));
		store.unwatchPens();
		expect(win.removed).toEqual(win.added);
		expect((store as unknown as { pensDown: Set<number> }).pensDown.size).toBe(0);
		expect((store as unknown as { penWatch: unknown }).penWatch).toBeNull();
	});

	it("a pen down is tracked and a touch is ignored; a lift releases held saves only when the last pen is up", () => {
		const win = fakeWindow();
		vi.stubGlobal("window", win);
		let released = 0;
		const store = bareStore({
			pensDown: new Set<number>(),
			penWatch: null,
			releaseHeld: () => released++,
		});
		store.watchPens();
		const down = win.handlers.get("pointerdown")!;
		const up = win.handlers.get("pointerup")!;
		const inner = store as unknown as { pensDown: Set<number> };
		down(touch(5));
		expect(inner.pensDown.size).toBe(0);
		down(pen(1));
		down(pen(2));
		expect([...inner.pensDown]).toEqual([1, 2]);
		up(touch(1));
		up(pen(9));
		expect(released).toBe(0);
		up(pen(1));
		expect(released).toBe(0);
		up(pen(2));
		expect(released).toBe(1);
		expect(inner.pensDown.size).toBe(0);
	});

	it("losing focus forgets every pen and releases held saves", () => {
		const win = fakeWindow();
		vi.stubGlobal("window", win);
		let released = 0;
		const store = bareStore({
			pensDown: new Set([1, 2]),
			penWatch: null,
			releaseHeld: () => released++,
		});
		store.watchPens();
		win.handlers.get("blur")!({});
		expect((store as unknown as { pensDown: Set<number> }).pensDown.size).toBe(0);
		expect(released).toBe(1);
	});

	it("releaseHeld wakes parked saves, re-arms a held page's quiet timer, and leaves a page past its bound to the lift task", () => {
		const win = fakeWindow();
		vi.stubGlobal("window", win);
		let woken = 0;
		const armed: string[] = [];
		const written: unknown[][] = [];
		const store = bareStore({
			parked: new Set([() => woken++]),
			heldForPen: new Set(["a", "b"]),
			pending: new Map([["a", {}], ["b", {}]]),
			heldPastBound: new Map([["b", 3]]),
			armQuiet: (id: string) => armed.push(id),
			writePending: (...args: unknown[]) => {
				written.push(args);
				return Promise.resolve();
			},
		});
		store.releaseHeld();
		expect(woken).toBe(1);
		expect(armed).toEqual(["a"]);
		expect(win.timeouts.map((t) => t.ms)).toEqual([0]);
		expect(written).toEqual([]);
		win.timeouts[0]!.fn();
		expect(written).toEqual([["b", true]]);
	});
});
