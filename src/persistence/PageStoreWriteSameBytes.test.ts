/**
 * F66-1: the save guard judges a file whose modified time moved by its bytes,
 * and trusts only the stamp of this session's own last write that far.
 *
 * A sync tool that writes an ink file back with the bytes this session last
 * saved and a new time used to leave a `<id>.conflict-<ms>.json` beside it and
 * a conflict notice: the guard called any moved time external and never read
 * the file (PageStoreWrite.ts, the `external` line). A file moved aside whose
 * content stamp equals the stamp of this session's own last write is now
 * removed like the same-time case: no copy, no notice.
 *
 * Kept as before, and pinned here: other bytes with a new time (equal length
 * too, so a compare of lengths alone fails), an unreadable file, no remembered
 * stamp, and a file landing at the live path between the two renames.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageData, emptyPage } from "../model/PageData";

const LIVE = ".handwriting/p1.json";

function pageWith(id: string, label: string): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = [
		{
			id: label,
			tool: "pen",
			color: "#4b7bec",
			width: 2.2,
			points: [
				{ x: 0, y: 0, pressure: 0.5, t: 0 },
				{ x: 10, y: 0, pressure: 0.5, t: 8 },
			],
			bbox: { x: 0, y: 0, width: 10, height: 0 },
			createdAt: 0,
		},
	];
	return p;
}

function serialize(id: string, label: string): string {
	return JSON.stringify({
		schemaVersion: 1,
		pageId: id,
		surface: "inline",
		textBoxes: [],
		images: [],
		strokes: pageWith(id, label).strokes,
	});
}

let fake: FakeAdapter;
let store: PageStore;
let conflicts: string[];

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	store = new PageStore({ vault: { adapter: fake } }, ".handwriting", () => 5_000_000);
	conflicts = [];
	store.onConflict = (_id, keptAs) => conflicts.push(keptAs);
});

afterEach(() => {
	vi.useRealTimers();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await vi.advanceTimersByTimeAsync(2000);
	}
}

/** Every conflict copy in the ink folder, by name. */
function conflictFiles(): string[] {
	return [...fake.files.keys()].filter((p) => p.includes(".conflict-")).sort();
}

/** Save `label` through the store and wait for it to land; returns the bytes it wrote. */
async function saved(label: string): Promise<string> {
	store.schedule("p1", pageWith("p1", label));
	await settle();
	const bytes = fake.files.get(LIVE);
	expect(bytes).toContain(label);
	return bytes!;
}

describe("F66-1 a moved-time file is judged by its bytes", () => {
	it("C1 same bytes written back with a new time, then a save: no conflict file, no notice, the new ink in place", async () => {
		const ours = await saved("v1");
		const before = fake.mtimes.get(LIVE)!;
		fake.externalWrite(LIVE, ours); // a sync tool: our last bytes, a new time
		expect(fake.mtimes.get(LIVE)).toBeGreaterThan(before);
		expect(conflictFiles()).toEqual([]);

		store.schedule("p1", pageWith("p1", "v2"));
		await settle();

		expect(conflictFiles()).toEqual([]);
		expect(conflicts).toEqual([]);
		expect(fake.files.get(LIVE)).toContain("v2");
		expect(store["knownMtime"].get("p1")).toBe(fake.mtimes.get(LIVE));
	});

	it("C2 other bytes of equal length with a new time keep the copy and the notice", async () => {
		const ours = await saved("AAAA");
		const theirs = ours.replace('"AAAA"', '"BBBB"');
		expect(theirs).not.toBe(ours);
		expect(theirs.length).toBe(ours.length);
		fake.externalWrite(LIVE, theirs);

		store.schedule("p1", pageWith("p1", "CCCC"));
		await settle();

		expect(conflicts.length).toBe(1);
		expect(conflictFiles()).toEqual([conflicts[0]]);
		expect(fake.files.get(conflicts[0]!)).toBe(theirs);
		expect(fake.files.get(LIVE)).toContain("CCCC");
	});

	it("C3 an unreadable moved-time file is kept, with one notice after the save lands", async () => {
		const ours = await saved("v1");
		fake.externalWrite(LIVE, ours); // our bytes, but the read of them fails
		const realRead = fake.read.bind(fake);
		fake.read = async (path: string) => {
			if (path.includes(".conflict-")) throw new Error("EIO injected read");
			return realRead(path);
		};
		const order: string[] = [];
		store.onConflict = (_id, keptAs) => {
			conflicts.push(keptAs);
			order.push(fake.files.get(LIVE)?.includes("v2") ? "after" : "before");
		};

		store.schedule("p1", pageWith("p1", "v2"));
		await settle();

		expect(conflicts.length).toBe(1);
		expect(order).toEqual(["after"]);
		expect(fake.files.get(conflicts[0]!)).toBe(ours);
		expect(fake.files.get(LIVE)).toContain("v2");
	});

	it("C4 a moved-time file with no remembered stamp is kept", async () => {
		fake.externalWrite(LIVE, serialize("p1", "THEIRS")); // never loaded or written by this store
		expect(store["knownHash"].has("p1")).toBe(false);

		store.schedule("p1", pageWith("p1", "mine"));
		await settle();

		expect(conflicts.length).toBe(1);
		expect(fake.files.get(conflicts[0]!)).toContain("THEIRS");
		expect(fake.files.get(LIVE)).toContain("mine");
	});

	it("C5 a stamp from a load is not trusted over a moved time: the same bytes touched after a load, before any save, are kept with a notice", async () => {
		const theirs = serialize("p1", "v1");
		fake.externalWrite(LIVE, theirs);
		await store.load("p1"); // the stamp and the time come from the load, not from a write of ours
		fake.externalWrite(LIVE, theirs); // a sync tool: the same bytes, a new time

		store.schedule("p1", pageWith("p1", "v2"));
		await settle();

		expect(conflicts.length).toBe(1);
		expect(conflictFiles()).toEqual([conflicts[0]]);
		expect(fake.files.get(conflicts[0]!)).toBe(theirs);
		expect(fake.files.get(LIVE)).toContain("v2");
	});

	it("C6 a same-bytes file landing at the live path between the two renames is still kept, with a notice", async () => {
		const ours = await saved("v1");
		const realRead = fake.read.bind(fake);
		let echoed = false;
		fake.read = async (path: string) => {
			// The guard reads the moved-aside file; a sync tool writes our last bytes back meanwhile.
			if (!echoed && path.includes(".conflict-")) {
				echoed = true;
				fake.externalWrite(LIVE, ours);
			}
			return realRead(path);
		};

		store.schedule("p1", pageWith("p1", "v2"));
		await settle();

		expect(echoed).toBe(true);
		expect(conflicts.length).toBe(1);
		expect(conflictFiles()).toEqual([conflicts[0]]);
		expect(fake.files.get(conflicts[0]!)).toBe(ours);
		expect(fake.files.get(LIVE)).toContain("v2");
	});

	it("F5 a failed remove of our own moved-time bytes fails nothing: the save lands, no notice, one stray copy of ours", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const ours = await saved("v1");
			fake.externalWrite(LIVE, ours);
			const realRemove = fake.remove.bind(fake);
			fake.remove = async (path: string) => {
				if (path.includes(".conflict-")) throw new Error("EPERM injected remove");
				return realRemove(path);
			};

			store.schedule("p1", pageWith("p1", "v2"));
			await settle();

			expect(conflicts).toEqual([]);
			expect(fake.files.get(LIVE)).toContain("v2");
			const stray = conflictFiles();
			expect(stray.length).toBe(1);
			expect(fake.files.get(stray[0]!)).toBe(ours);
			expect(error).toHaveBeenCalledWith("[handwriting] could not remove the replaced sidecar", stray[0], expect.any(Error));
		} finally {
			error.mockRestore();
		}
	});
});

describe("the trusted stamp is the own LAST write's, and only when it equals the remembered one", () => {
	it("X1 a page saved, then a load raced by other bytes, then a save: the racer is kept with a notice", async () => {
		await saved("v1");
		const realRead = fake.read.bind(fake);
		let raced = false;
		fake.read = async (path: string) => {
			if (!raced && path === LIVE) {
				raced = true;
				fake.externalWrite(LIVE, serialize("p1", "RACER"));
			}
			return realRead(path);
		};
		await store.load("p1");
		expect(raced).toBe(true);
		store.schedule("p1", pageWith("p1", "mine"));
		await settle();
		expect(conflicts.length).toBe(1);
		expect(fake.files.get(conflicts[0]!)).toContain("RACER");
		expect(fake.files.get(LIVE)).toContain("mine");
	});

	it("X2 our second save's bytes written back with a new time, then a save: no copy, no notice", async () => {
		await saved("v1");
		const ours2 = await saved("v2");
		fake.externalWrite(LIVE, ours2);
		store.schedule("p1", pageWith("p1", "v3"));
		await settle();
		expect(conflictFiles()).toEqual([]);
		expect(conflicts).toEqual([]);
		expect(fake.files.get(LIVE)).toContain("v3");
	});
});
