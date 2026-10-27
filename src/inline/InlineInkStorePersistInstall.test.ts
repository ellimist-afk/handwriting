/**
 * The inline ink store's adoption, save and vault methods live in
 * InlineInkStorePersist.ts and are installed on InlineInkStore.prototype when
 * InlineInkStore.ts loads. Four things a type check cannot see are held here,
 * as the install tests of the other split files hold them for theirs.
 *
 * LOAD ORDER. InlineInkStore.ts imports the install function, and the persist
 * file imports the class back, so the two modules form a cycle. Every other test
 * imports InlineInkStore.ts first. This file imports the persist file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the
 * descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when that
 * save or vault path ran on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * persist file declares each once, so a half-finished move cannot pass with the
 * old copy still shadowing the new one.
 *
 * ONE DOOR. The persist file names nothing of the store beyond the list below.
 */
import { describe, expect, it } from "vitest";

import { installInlineInkStorePersist } from "./InlineInkStorePersist";
import { InlineInkStore, type InlineInkHost, type NoteRecord } from "./InlineInkStore";
import storeRaw from "./InlineInkStore.ts?raw";
import persistRaw from "./InlineInkStorePersist.ts?raw";

const MOVED = [
	"reloadExternal",
	"adoptExternal",
	"noteAdoptionFailure",
	"cacheStats",
	"restoreRevision",
	"save",
	"persist",
	"trackPersist",
	"claim",
	"retryRefusedClaim",
	"snapshot",
	"schedule",
	"scheduleFirst",
	"settle",
	"noteOnce",
	"noticeTransient",
	"handleRename",
	"dropRenamesTouching",
	"consumeRename",
	"handleDelete",
	"markDuplicateLocked",
	"clearDuplicateLock",
	"isDuplicateLocked",
	"handleDeclaimed",
	"carryOwnInk",
	"reassignPage",
	"scheduleLoaded",
] as const;

/** Every name the persist file takes from the store, and nothing else. */
const FROM_STORE = [
	"ADOPTION_QUIET_MS",
	"ADOPTION_RUN_GAP_MS",
	"ADOPTION_STILL_FAILING",
	"ExternalAdoptionHeldReason",
	"ExternalAdoptionResult",
	"INK_FILE_MISSING",
	"InlineInkStore",
	"NoteRecord",
	"inkFingerprint",
];

const storeSrc = storeRaw.replace(/\r\n/g, "\n");
const persistSrc = persistRaw.replace(/\r\n/g, "\n");

/** A store with no host of its own: the prototype, an own byPath and a recording host. */
function bareStore(): { store: InlineInkStore; said: string[] } {
	const store = Object.create(InlineInkStore.prototype) as InlineInkStore;
	Object.defineProperty(store, "byPath", { value: new Map<string, NoteRecord>() });
	const said: string[] = [];
	store.host = { notify: (message: string) => said.push(message) } as unknown as InlineInkHost;
	return { store, said };
}

describe("persistence methods on the inline ink store prototype", () => {
	it("load with the persist file imported first, and moved methods run on a bare store", () => {
		expect(typeof installInlineInkStorePersist).toBe("function");
		const { store, said } = bareStore();

		expect(store.cacheStats()).toEqual({ notes: 0, strokes: 0, points: 0 });
		const a = store.record("a.md");
		a.strokes.push({ id: "s1", points: [{}, {}, {}] } as never, { id: "s2", points: [{}] } as never);
		store.record("b.md");
		expect(store.cacheStats()).toEqual({ notes: 2, strokes: 2, points: 4 });

		expect(store.isDuplicateLocked("zz.md")).toBe(false);
		expect(store.isDuplicateLocked("a.md")).toBe(false);
		a.duplicateLocked = true;
		expect(store.isDuplicateLocked("a.md")).toBe(true);

		const b = store.record("b.md");
		store.noteOnce(b, "first");
		store.noteOnce(b, "second");
		expect(said).toEqual(["first"]);
		expect(b.noticed).toBe(true);
	});

	it("the duplicate lock is set once with one notice and cleared with one notice", () => {
		const { store, said } = bareStore();
		store.markDuplicateLocked("a.md", "other.md");
		store.markDuplicateLocked("a.md", "other.md");
		expect(store.isDuplicateLocked("a.md")).toBe(true);
		expect(said).toHaveLength(1);
		expect(said[0]).toContain('"other.md"');
		expect(store.record("a.md").noticed).toBe(true);

		store.clearDuplicateLock("zz.md");
		expect(said).toHaveLength(1);
		store.clearDuplicateLock("a.md");
		expect(store.isDuplicateLocked("a.md")).toBe(false);
		expect(store.record("a.md").noticed).toBe(false);
		expect(said).toHaveLength(2);
		expect(said[1]).toContain("duplicate resolved");
		store.clearDuplicateLock("a.md");
		expect(said).toHaveLength(2);
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		for (const name of MOVED) {
			const d = Object.getOwnPropertyDescriptor(InlineInkStore.prototype, name);
			expect(d, `${name} is not on the prototype`).toBeDefined();
			expect(typeof d!.value, name).toBe("function");
			expect(
				{ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable },
				name
			).toEqual({ writable: true, enumerable: false, configurable: true });
		}
	});

	it("each moved name is declared once in the persist file and not in the class", () => {
		const classStart = storeSrc.indexOf("export class InlineInkStore {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = storeSrc.slice(classStart, storeSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = persistSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: InlineInkStore\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in InlineInkStorePersist.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the store installs once, after the class closing brace and before the load install", () => {
		const call = "installInlineInkStorePersist(InlineInkStore.prototype);";
		expect(storeSrc.split(call).length - 1).toBe(1);
		const classStart = storeSrc.indexOf("export class InlineInkStore {");
		const classEnd = storeSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(storeSrc.indexOf(call)).toBeGreaterThan(classEnd);
		expect(storeSrc.indexOf(call)).toBeLessThan(storeSrc.indexOf("installInlineInkStoreLoad(InlineInkStore.prototype);"));
	});

	it("the persist file takes exactly the listed names from the store", () => {
		const imports = [...persistSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/InlineInkStore";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_STORE].sort());
	});
});
