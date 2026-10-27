/**
 * The page store's write path methods live in PageStoreWrite.ts and are
 * installed on PageStore.prototype when PageStore.ts loads. Four things a type
 * check cannot see are held here, as the install tests of the other split files
 * hold them for theirs.
 *
 * LOAD ORDER. PageStore.ts imports the install function, and the new file
 * imports values back, so the two modules form a cycle. Every other test
 * imports PageStore.ts first. This file imports the new file first, so a cycle
 * that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the
 * descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when that
 * path ran on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * new file declares each once, so a half-finished move cannot pass with the old
 * copy still shadowing the new one.
 *
 * ONE DOOR. The new file names nothing of the store beyond the list below.
 */
import { describe, expect, it } from "vitest";

import { installPageStoreWrite } from "./PageStoreWrite";
import { PageStore, type PageWriter } from "./PageStore";
import storeRaw from "./PageStore.ts?raw";
import fileRaw from "./PageStoreWrite.ts?raw";

const MOVED = [
	"writeVerified",
	"penPause",
	"writePending",
	"retireWriter",
	"reconcileInProcess",
	"writeNow",
	"writeNowInFlight",
	"absorbProvisional",
	"freeConflictPath",
] as const;

/** Every name the new file takes from the store, and nothing else. */
const FROM_STORE = ["MAX_DIRTY_MS", "PageStore", "PageWriter", "WRITE_MAX_RETRIES", "WRITE_RETRY_MS", "beginContentStamp", "contentStampSliced", "folderOf", "recoverExactPage", "stripJson"];

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

describe("write path methods on the page store prototype", () => {
	it("loads with the new file imported first, and moved methods run on a bare store", async () => {
		expect(typeof installPageStoreWrite).toBe("function");
		const w = {} as PageWriter;
		const other = {} as PageWriter;
		const retiredWriters = new Set<PageWriter>();
		const lastWriter = new Map<string, PageWriter | undefined>([
			["p1", w],
			["p2", other],
		]);
		const store = bareStore({ retiredWriters, lastWriter });
		store.retireWriter(w);
		expect(retiredWriters.has(w)).toBe(true);
		expect(retiredWriters.has(other)).toBe(false);
		expect(lastWriter.has("p1")).toBe(true);
		expect(lastWriter.get("p1")).toBeUndefined();
		expect(lastWriter.get("p2")).toBe(other);

		const asked: string[] = [];
		const exists = async (path: string): Promise<boolean> => {
			asked.push(path);
			return path === "a/b.conflict-5.json";
		};
		const vault = bareStore({ app: { vault: { adapter: { exists } } } });
		expect(await vault.freeConflictPath("a/b.json", 5)).toBe("a/b.conflict-5-2.json");
		expect(asked).toEqual(["a/b.conflict-5.json", "a/b.conflict-5-2.json"]);
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
			expect(inFile?.length ?? 0, `${name} in PageStoreWrite.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the store installs once, after the class closing brace", () => {
		const call = "installPageStoreWrite(PageStore.prototype);";
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
