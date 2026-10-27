/**
 * The page store's path, folder search and trash methods live in PageStorePaths.ts and are
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
import { normalizePath } from "obsidian";
import { installPageStorePaths } from "./PageStorePaths";
import { PageStore } from "./PageStore";
import storeRaw from "./PageStore.ts?raw";
import fileRaw from "./PageStorePaths.ts?raw";

const MOVED = [
	"pathIn",
	"path",
	"searchFolders",
	"listIds",
	"inkFolder",
	"inkFolders",
	"holdWrites",
	"releaseWrites",
	"useInkFolder",
	"findSidecar",
	"chooseBetweenFolders",
	"preserveTwoFolderFork",
	"resolvePath",
	"resolveFor",
	"findElsewhere",
	"pinnedPath",
	"tmpFor",
	"trashDirIn",
	"trashDirOf",
	"trashFolderFor",
	"freeTrashPath",
] as const;

/** Every name the new file takes from the store, and nothing else. */
const FROM_STORE = ["PageStore", "contentStamp", "folderOf"];

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

describe("path methods on the page store prototype", () => {
	it("loads with the new file imported first, and moved methods run on a bare store", () => {
		expect(typeof installPageStorePaths).toBe("function");
		const store = bareStore();
		expect(store.tmpFor("a/b.json")).toBe("a/b.json.tmp");
		expect(store.trashDirIn("x")).toBe(normalizePath("x/trash"));
		expect(store.pathIn("f", "p1")).toBe(normalizePath("f/p1.json"));
		expect(() => store.pathIn("f", "../x")).toThrow(/refusing to build a sidecar path/);
		expect(bareStore({ folder: ".handwriting" }).searchFolders()).toEqual([".handwriting", "handwriting"]);
		expect(bareStore({ folder: "handwriting" }).searchFolders()).toEqual(["handwriting", ".handwriting"]);
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
			expect(inFile?.length ?? 0, `${name} in PageStorePaths.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the store installs once, after the class closing brace", () => {
		const call = "installPageStorePaths(PageStore.prototype);";
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
