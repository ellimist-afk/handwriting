/**
 * The page store's load and recovery methods live in PageStoreLoad.ts and are
 * installed on PageStore.prototype when PageStore.ts loads. Four things a type
 * check cannot see are held here, as the install tests of the other split files
 * hold them for theirs.
 *
 * LOAD ORDER. PageStore.ts imports the install function, and the load file
 * imports values back (contentStamp, folderOf, stripJson), so the two modules
 * form a cycle. Every other test imports PageStore.ts first. This file imports
 * the load file first, so a cycle that only works in the usual order fails here,
 * at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the
 * descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when that
 * load or recovery path ran on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * load file declares each once, so a half-finished move cannot pass with the
 * old copy still shadowing the new one.
 *
 * ONE DOOR. The load file names nothing of the store beyond the list below.
 */
import { describe, expect, it } from "vitest";

import { installPageStoreLoad } from "./PageStoreLoad";
import { PageStore } from "./PageStore";
import storeRaw from "./PageStore.ts?raw";
import loadRaw from "./PageStoreLoad.ts?raw";

const MOVED = [
	"load",
	"loadFromDisk",
	"findInterruptedSave",
	"restoreFromTrash",
	"restoreFirstOf",
	"promoteTmpOverDamaged",
	"carrierFor",
	"parseCarrier",
	"recoverFlushCarrier",
	"freeDamagedPath",
	"freeKeptPath",
] as const;

/** Every name the load file takes from the store, and nothing else. */
const FROM_STORE = ["LoadResult", "PageStore", "contentStamp", "folderOf", "stripJson"];

const storeSrc = storeRaw.replace(/\r\n/g, "\n");
const loadSrc = loadRaw.replace(/\r\n/g, "\n");

/** A store with no vault, as the other install tests build theirs: the prototype and the fields a method reads. */
function bareStore(): PageStore {
	return Object.create(PageStore.prototype) as PageStore;
}

describe("load and recovery methods on the page store prototype", () => {
	it("load with the load file imported first, and moved methods run on a bare store", async () => {
		expect(typeof installPageStoreLoad).toBe("function");
		const store = bareStore();
		expect(store.carrierFor("a/b.json")).toBe("a/b.json.flush");

		const asked: string[] = [];
		const exists = async (path: string): Promise<boolean> => {
			asked.push(path);
			return path === "a/b.kept-7.json";
		};
		Object.defineProperty(store, "app", { value: { vault: { adapter: { exists } } } });
		expect(await store.freeKeptPath("a/b.json", "kept", 7)).toBe("a/b.kept-7-2.json");
		expect(asked).toEqual(["a/b.kept-7.json", "a/b.kept-7-2.json"]);
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

	it("each moved name is declared once in the load file and not in the class", () => {
		const classStart = storeSrc.indexOf("export class PageStore {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = storeSrc.slice(classStart, storeSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = loadSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: PageStore\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in PageStoreLoad.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the store installs once, after the class closing brace, as the last statement of the file", () => {
		const call = "installPageStoreLoad(PageStore.prototype);";
		expect(storeSrc.split(call).length - 1).toBe(1);
		const classStart = storeSrc.indexOf("export class PageStore {");
		const classEnd = storeSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(storeSrc.indexOf(call)).toBeGreaterThan(classEnd);
		expect(storeSrc.trimEnd().endsWith(call)).toBe(true);
	});

	it("the load file takes exactly the listed names from the store", () => {
		const imports = [...loadSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/PageStore";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_STORE].sort());
	});
});
