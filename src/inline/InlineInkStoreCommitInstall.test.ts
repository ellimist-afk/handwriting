/**
 * The inline ink store's commit methods live in InlineInkStoreCommit.ts and are
 * installed on InlineInkStore.prototype when InlineInkStore.ts loads. Four things
 * a type check cannot see are held here, as the install tests of the other split
 * files hold them for theirs.
 *
 * LOAD ORDER. InlineInkStore.ts imports the install function, and the commit file
 * imports the class back as a type only. Every other test imports
 * InlineInkStore.ts first. This file imports the commit file first, so a cycle
 * that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the
 * descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when that
 * gesture ran on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * commit file declares each once, so a half-finished move cannot pass with the
 * old copy still shadowing the new one.
 *
 * ONE DOOR. The commit file names nothing of the store beyond the list below.
 */
import { describe, expect, it } from "vitest";

import { installInlineInkStoreCommit } from "./InlineInkStoreCommit";
import { InlineInkStore } from "./InlineInkStore";
import storeRaw from "./InlineInkStore.ts?raw";
import commitRaw from "./InlineInkStoreCommit.ts?raw";
import type { InkStroke } from "../ink/Stroke";

const MOVED = [
	"commit",
	"commitGesture",
	"applyAdd",
	"applyAddLive",
	"reinsertLive",
	"insert",
	"applyRemove",
	"takeLive",
	"standsAt",
	"holdsAll",
	"recordIds",
	"take",
	"moveStrokes",
] as const;

/** Every name the commit file takes from the store, and nothing else. */
const FROM_STORE = ["InlineInkStore", "NoteRecord"];

const storeSrc = storeRaw.replace(/\r\n/g, "\n");
const commitSrc = commitRaw.replace(/\r\n/g, "\n");

function stroke(id: string, x = 0, y = 0): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x, y, pressure: 0.5, t: 0 },
			{ x: x + 10, y: y + 10, pressure: 0.5, t: 8 },
		],
		bbox: { x, y, width: 10, height: 10 },
		createdAt: 0,
	};
}

/** A store with no host: the prototype and an own byPath. */
function bareStore(): InlineInkStore {
	const store = Object.create(InlineInkStore.prototype) as InlineInkStore;
	Object.defineProperty(store, "byPath", { value: new Map() });
	return store;
}

describe("commit methods on the inline ink store prototype", () => {
	it("load with the commit file imported first, and moved methods run on a bare store", () => {
		expect(typeof installInlineInkStoreCommit).toBe("function");
		const store = bareStore();
		const rec = store.record("a.md");
		rec.strokes.push(stroke("s1", 0, 0), stroke("s2", 5, 5));

		expect(store.recordIds("a.md")).toEqual(["s1", "s2"]);
		expect(store.recordIds("zz.md")).toEqual([]);
		expect(store.holdsAll("a.md", ["s1", "s2"])).toBe(true);
		expect(store.holdsAll("a.md", ["s1", "x"])).toBe(false);
		expect(store.holdsAll("zz.md", [])).toBe(true);
		expect(store.holdsAll("zz.md", ["s1"])).toBe(false);
		expect(store.standsAt("a.md", ["s1", "s2"], [{ x: 0, y: 0 }, { x: 5, y: 5 }])).toBe(true);
		expect(store.standsAt("a.md", ["s1"], [{ x: 0.5, y: 0 }])).toBe(false);
		expect(store.standsAt("a.md", ["s1"], [])).toBe(false);
		expect(store.standsAt("zz.md", ["s1"], [{ x: 0, y: 0 }])).toBe(false);
	});

	it("moveStrokes moves only the named strokes and take hands back ascending indices", () => {
		const store = bareStore();
		const rec = store.record("a.md");
		rec.strokes.push(stroke("s1", 0, 0), stroke("s2", 5, 5), stroke("s3", 9, 9));

		store.moveStrokes("a.md", ["s2"], 3, -2);
		expect(rec.strokes.map((s) => s.points[0]!.x + "," + s.points[0]!.y)).toEqual(["0,0", "8,3", "9,9"]);
		expect(rec.localStrokeIds.has("s2")).toBe(true);
		expect(rec.mutationGeneration).toBe(1);
		store.moveStrokes("a.md", ["s2"], 0, 0);
		expect(rec.mutationGeneration).toBe(1);

		const taken = store.takeLive("a.md", ["s3", "s1"]);
		expect(taken.map((t) => [t.stroke.id, t.index])).toEqual([["s1", 0], ["s3", 2]]);
		expect(store.recordIds("a.md")).toEqual(["s2"]);
		expect(rec.mutationGeneration).toBe(2);
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

	it("each moved name is declared once in the commit file and not in the class", () => {
		const classStart = storeSrc.indexOf("export class InlineInkStore {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = storeSrc.slice(classStart, storeSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = commitSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: InlineInkStore\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in InlineInkStoreCommit.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the store installs once, after the class closing brace and before the load install", () => {
		const call = "installInlineInkStoreCommit(InlineInkStore.prototype);";
		expect(storeSrc.split(call).length - 1).toBe(1);
		const classStart = storeSrc.indexOf("export class InlineInkStore {");
		const classEnd = storeSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(storeSrc.indexOf(call)).toBeGreaterThan(classEnd);
		expect(storeSrc.indexOf(call)).toBeLessThan(storeSrc.indexOf("installInlineInkStoreLoad(InlineInkStore.prototype);"));
	});

	it("the commit file takes exactly the listed names from the store", () => {
		const imports = [...commitSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/InlineInkStore";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_STORE].sort());
	});
});
