import { describe, expect, it } from "vitest";
import { PageIdIndex } from "./PageIdIndex";

describe("PageIdIndex — ownership ledger for duplicate detection", () => {
	it("startup census: unique ids register, collisions register NO owner", () => {
		const idx = new PageIdIndex();
		const r = idx.rebuild([
			{ path: "a.md", id: "A" },
			{ path: "b.md", id: "B" },
			{ path: "b copy.md", id: "B" }, // duplicated while the app was closed
		]);
		expect(r.registered).toBe(1);
		expect(idx.owner("A")).toBe("a.md");
		// Deciding between b.md and "b copy.md" here would be iteration
		// order — the exact evidence source that is forbidden.
		expect(idx.owner("B")).toBeUndefined();
		expect(r.collisions.get("B")).toEqual(["b.md", "b copy.md"]);
	});

	it("lifecycle evidence: the note that held the id first is the original", () => {
		const idx = new PageIdIndex();
		expect(idx.register("orig.md", "X").kind).toBe("registered");
		expect(idx.register("orig.md", "X").kind).toBe("same");
		const v = idx.register("orig copy.md", "X");
		expect(v).toEqual({ kind: "duplicate", ownerPath: "orig.md" });
		// The duplicate verdict is NOT destructive: ownership did not move.
		expect(idx.owner("X")).toBe("orig.md");
	});

	it("rename moves ownership with the note; identity never changes", () => {
		const idx = new PageIdIndex();
		idx.register("Untitled.md", "X");
		idx.handleRename("Untitled.md", "Lecture 4.md");
		expect(idx.owner("X")).toBe("Lecture 4.md");
		expect(idx.register("Lecture 4.md", "X").kind).toBe("same");
	});

	it("delete frees the id; a resolved collision can then claim ownership", () => {
		const idx = new PageIdIndex();
		idx.register("a.md", "X");
		expect(idx.handleDelete("a.md")).toEqual(["X"]);
		expect(idx.owner("X")).toBeUndefined();
		idx.claimOwnership("X", "survivor.md");
		expect(idx.owner("X")).toBe("survivor.md");
	});

	it("release only lets go when the path actually owns the id", () => {
		const idx = new PageIdIndex();
		idx.register("a.md", "X");
		idx.release("b.md", "X"); // not the owner — no-op
		expect(idx.owner("X")).toBe("a.md");
		idx.release("a.md", "X");
		expect(idx.owner("X")).toBeUndefined();
	});

	it("snapshot round-trips into the persisted owner memory", () => {
		const idx = new PageIdIndex();
		idx.register("a.md", "A");
		idx.register("b.md", "B");
		expect(idx.snapshot()).toEqual({ A: "a.md", B: "b.md" });
	});
});
