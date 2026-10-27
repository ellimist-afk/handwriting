/**
 * The page store's removal path (the copy of a page's sidecar for a duplicated note, the drop of
 * a queued save, the recycle of a removed page's files into the trash, and the recycle of a write
 * that failed after its page was removed) lives in PageStoreRemove.ts and is installed on
 * PageStore.prototype when PageStore.ts loads. Four things a type check cannot see are held here,
 * as the install tests of the other split files hold them for theirs.
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
import { describe, expect, it } from "vitest";
import { installPageStoreRemove } from "./PageStoreRemove";
import { PageStore } from "./PageStore";
import { emptyPage } from "../model/PageData";
import storeRaw from "./PageStore.ts?raw";
import fileRaw from "./PageStoreRemove.ts?raw";

const MOVED = ["clone", "discardPending", "remove", "recycleFailedWrite"] as const;

/** Every name the new file takes from the store, and nothing else. */
const FROM_STORE = ["PageStore", "WRITE_RETRY_MS", "contentStamp", "folderOf"];

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

describe("removal methods on the page store prototype", () => {
	it("loads with the new file imported first, and a moved method runs on a bare store", () => {
		expect(typeof installPageStoreRemove).toBe("function");
		const cleared: string[] = [];
		const store = bareStore({
			pending: new Map([["p", emptyPage("p")]]),
			pendingWriter: new Map([["p", undefined]]),
			pendingCovers: new Map([["p", undefined]]),
			clearTimers: (id: string) => cleared.push(id),
		});
		store.discardPending("p");
		expect(cleared).toEqual(["p"]);
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
			expect(inFile?.length ?? 0, `${name} in PageStoreRemove.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the store installs once, after the class closing brace", () => {
		const call = "installPageStoreRemove(PageStore.prototype);";
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

describe("the removal methods on a bare store", () => {
	it("discardPending drops the queued state, its writer and its cover, and clears the page's timers once", () => {
		const cleared: string[] = [];
		const store = bareStore({
			pending: new Map([["p", emptyPage("p")], ["q", emptyPage("q")]]),
			pendingWriter: new Map<string, unknown>([["p", {}], ["q", {}]]),
			pendingCovers: new Map<string, unknown>([["p", 1], ["q", 2]]),
			clearTimers: (id: string) => cleared.push(id),
		});
		store.discardPending("p");
		const inner = store as unknown as { pending: Map<string, unknown>; pendingWriter: Map<string, unknown>; pendingCovers: Map<string, unknown> };
		expect([...inner.pending.keys()]).toEqual(["q"]);
		expect([...inner.pendingWriter.keys()]).toEqual(["q"]);
		expect([...inner.pendingCovers.keys()]).toEqual(["q"]);
		expect(cleared).toEqual(["p"]);
	});

	it("recycleFailedWrite recycles nothing for an empty page", () => {
		const store = bareStore({
			app: { vault: { adapter: {} } },
			chain: () => {
				throw new Error("an empty page must not be recycled");
			},
		});
		store.recycleFailedWrite("p", emptyPage("p"), undefined, 0);
	});

	it("recycleFailedWrite queues one recycle when the page holds only its own paper or canvas choice", () => {
		for (const choice of [{ notePaper: "dots" }, { noteCanvas: false }] as const) {
			const queued: string[] = [];
			const store = bareStore({
				app: { vault: { adapter: {} } },
				chain: (id: string) => {
					queued.push(id);
					return Promise.resolve();
				},
			});
			store.recycleFailedWrite("p", { ...emptyPage("p"), ...choice } as never, undefined, 0);
			expect(queued, JSON.stringify(choice)).toEqual(["p"]);
		}
	});

	it("recycleFailedWrite queues one recycle for a page with a stroke", () => {
		const queued: string[] = [];
		const store = bareStore({
			app: { vault: { adapter: {} } },
			chain: (id: string) => {
				queued.push(id);
				return Promise.resolve();
			},
		});
		const page = emptyPage("p");
		page.strokes.push({} as never);
		store.recycleFailedWrite("p", page, undefined, 0);
		expect(queued).toEqual(["p"]);
	});
});
