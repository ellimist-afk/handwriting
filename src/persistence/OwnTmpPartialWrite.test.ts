/**
 * A .tmp this store's own save created is never kept as a conflict copy,
 * even when the write that created it threw. A write
 * that creates the file and then fails (a full disk) leaves partial bytes at
 * the .tmp name; when the store marked the name as its own only after a
 * successful write, the retry took those bytes for a stranded foreign save
 * and kept and announced them, one junk copy per retry.
 */
import { describe, expect, it } from "vitest";
import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageData, emptyPage, serializePage } from "../model/PageData";

(globalThis as { window?: unknown }).window = globalThis;

function pageOf(id: string, ...labels: string[]): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = labels.map((l) => ({
		id: l,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
	})) as PageData["strokes"];
	return p;
}

/** The first write to a .tmp creates the file with partial bytes, then throws. */
class PartialTmpWrite extends FakeAdapter {
	failNextTmp = true;
	override async write(path: string, data: string): Promise<void> {
		if (this.failNextTmp && path.endsWith(".tmp")) {
			this.failNextTmp = false;
			this.externalWrite(path, data.slice(0, Math.floor(data.length / 2)));
			throw new Error("ENOSPC: no space left on device");
		}
		return super.write(path, data);
	}
}

describe("a partial .tmp left by this store's own failed write", () => {
	it("is overwritten by the retry: no conflict copy, no announcement", async () => {
		const fake = new PartialTmpWrite();
		fake.dirs.add(".handwriting");
		fake.externalWrite(".handwriting/X.json", serializePage(pageOf("X", "base")));
		const store = new PageStore({ vault: { adapter: fake } });
		await store.load("X");
		const conflicts: string[] = [];
		store.onConflict = (_id, keptAs) => conflicts.push(keptAs);

		await store.saveNow("X", pageOf("X", "base", "mine"));
		expect(fake.files.has(".handwriting/X.json.tmp"), "precondition: the failed write left a partial .tmp").toBe(true);
		await store.flush(); // the retry

		const kept = [...fake.files.keys()].filter((p) => p.includes(".conflict-"));
		expect(kept, "the store's own partial .tmp was kept as a conflict copy").toEqual([]);
		expect(conflicts, "the store's own partial .tmp was announced").toEqual([]);
		expect(fake.files.get(".handwriting/X.json")).toContain('"mine"');
	});
});

describe("a .tmp name this store gave up when the note was deleted", () => {
	it("is no longer its own: a foreign .tmp at that name is kept by the next save", async () => {
		const fake = new PartialTmpWrite();
		fake.dirs.add(".handwriting");
		fake.externalWrite(".handwriting/X.json", serializePage(pageOf("X", "base")));
		const store = new PageStore({ vault: { adapter: fake } });
		await store.load("X");
		const conflicts: string[] = [];
		store.onConflict = (_id, keptAs) => conflicts.push(keptAs);

		// A save fails after creating its .tmp, so the name is marked as this store's.
		await store.saveNow("X", pageOf("X", "base", "mine"));
		expect(fake.files.has(".handwriting/X.json.tmp"), "precondition: the failed write left a partial .tmp").toBe(true);

		// The note is deleted: its .tmp goes to the trash.
		await store.remove("X");
		expect(fake.files.has(".handwriting/X.json.tmp"), "precondition: the .tmp was recycled").toBe(false);

		// Another device or process leaves an interrupted save at the same name.
		fake.externalWrite(".handwriting/X.json.tmp", serializePage(pageOf("X", "foreign")));

		// The same id is written again (the note restored, or recreated).
		await store.saveNow("X", pageOf("X", "again"));

		const holdsForeign = [...fake.files.values()].some((text) => text.includes('"id":"foreign"'));
		expect(holdsForeign, "the foreign .tmp was overwritten by this store's save").toBe(true);
		const kept = [...fake.files.keys()].filter((p) => p.includes(".conflict-"));
		expect(kept.some((p) => fake.files.get(p)!.includes('"id":"foreign"')), "kept as a conflict copy").toBe(true);
		expect(fake.files.get(".handwriting/X.json")).toContain('"again"');
	});
});
