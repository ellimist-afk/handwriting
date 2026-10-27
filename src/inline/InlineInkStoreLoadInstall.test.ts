/**
 * The inline ink store's loading methods live in InlineInkStoreLoad.ts and are
 * installed on InlineInkStore.prototype when InlineInkStore.ts loads. Four things
 * a type check cannot see are held here, as the install tests of the other split
 * files hold them for theirs.
 *
 * LOAD ORDER. InlineInkStore.ts imports the install function, and the load file
 * imports values back (choicesKeyOf, inkFingerprint, PARSER_INVENTED_STROKE_FIELDS),
 * so the two modules form a cycle. Every other test imports InlineInkStore.ts
 * first. This file imports the load file first, so a cycle that only works in the
 * usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the
 * descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when that
 * load path ran on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * load file declares each once, so a half-finished move cannot pass with the
 * old copy still shadowing the new one.
 *
 * ONE DOOR. The load file names nothing of the store beyond the list below.
 */
import { describe, expect, it } from "vitest";

import { installInlineInkStoreLoad } from "./InlineInkStoreLoad";
import { InlineInkStore, type NoteRecord } from "./InlineInkStore";
import storeRaw from "./InlineInkStore.ts?raw";
import loadRaw from "./InlineInkStoreLoad.ts?raw";

const MOVED = [
	"isLoaded",
	"ensureLoaded",
	"refreshOnReopen",
	"loadRecord",
	"trackLoad",
	"retryDamaged",
	"holdUnreadQuietly",
	"adoptSidecar",
	"captureHistoryIdentity",
	"pathForHistoryIdentity",
	"pageIdOf",
	"pathForPageId",
	"isDamagedLocked",
	"deleteAllReadiness",
	"captureDeleteAll",
	"currentMatchesCapture",
	"backupMatchesCapture",
	"throughCodec",
	"isHandwritingPage",
] as const;

/** Every name the load file takes from the store, and nothing else. */
const FROM_STORE = [
	"InlineDeleteCapture",
	"InlineDeleteReadiness",
	"InlineDeleteTarget",
	"InlineInkStore",
	"NoteRecord",
	"PARSER_INVENTED_STROKE_FIELDS",
	"choicesKeyOf",
	"inkFingerprint",
];

const storeSrc = storeRaw.replace(/\r\n/g, "\n");
const loadSrc = loadRaw.replace(/\r\n/g, "\n");

/** A record with only the fields the bare calls below read. */
function rec(fields: Partial<Pick<NoteRecord, "pageId" | "load" | "damagedLocked">>): NoteRecord {
	return { pageId: null, load: "no", damagedLocked: false, ...fields } as unknown as NoteRecord;
}

/** A store with no host, as the other install tests build theirs: the prototype and an own byPath. */
function bareStore(records: Record<string, NoteRecord>): InlineInkStore {
	const store = Object.create(InlineInkStore.prototype) as InlineInkStore;
	Object.defineProperty(store, "byPath", { value: new Map(Object.entries(records)) });
	return store;
}

describe("loading methods on the inline ink store prototype", () => {
	it("load with the load file imported first, and moved methods run on a bare store", () => {
		expect(typeof installInlineInkStoreLoad).toBe("function");
		const store = bareStore({
			"a.md": rec({ pageId: "p1", load: "yes" }),
			"b.md": rec({ pageId: "p2", load: "yes", damagedLocked: true }),
			"c.md": rec({ pageId: "p3", load: "no" }),
		});
		expect(store.pageIdOf("a.md")).toBe("p1");
		expect(store.pageIdOf("zz.md")).toBeNull();
		expect(store.pathForPageId("p2")).toBe("b.md");
		expect(store.pathForPageId("p9")).toBeNull();
		expect(store.isDamagedLocked("b.md")).toBe(true);
		expect(store.isDamagedLocked("a.md")).toBe(false);
		expect(store.isDamagedLocked("zz.md")).toBe(false);
		expect(store.isLoaded("a.md")).toBe(true);
		expect(store.isLoaded("b.md")).toBe(false);
		expect(store.isLoaded("c.md")).toBe(false);
		expect(store.isLoaded("zz.md")).toBe(false);
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

	it("each moved name is declared once in the load file and not in the class", () => {
		const classStart = storeSrc.indexOf("export class InlineInkStore {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = storeSrc.slice(classStart, storeSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = loadSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: InlineInkStore\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in InlineInkStoreLoad.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the store installs once, after the class closing brace, as the last statement of the file", () => {
		const call = "installInlineInkStoreLoad(InlineInkStore.prototype);";
		expect(storeSrc.split(call).length - 1).toBe(1);
		const classStart = storeSrc.indexOf("export class InlineInkStore {");
		const classEnd = storeSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(storeSrc.indexOf(call)).toBeGreaterThan(classEnd);
		expect(storeSrc.trimEnd().endsWith(call)).toBe(true);
	});

	it("the load file takes exactly the listed names from the store", () => {
		const imports = [...loadSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/InlineInkStore";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_STORE].sort());
	});
});
