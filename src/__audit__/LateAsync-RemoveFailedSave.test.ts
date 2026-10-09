/**
 * Late async result: a save that is already running when the note is
 * deleted, and then FAILS.
 *
 * PageStore.remove drops the queue, the timers and the per-writer sequence
 * map at once, then recycles the live file on the write queue. The running
 * write fails afterwards; its catch put the payload back in `pending`,
 * because `superseded` reads the sequence map that remove had just deleted,
 * and armed a retry timer. The retry wrote a live sidecar for a note that no
 * longer exists, and the trash held one step older than the ink last drawn.
 *
 * Now the failed payload goes to the trash as the newest generation, with the
 * retries the write had left, and never to a live file or the queue.
 *
 * Assertions state the CORRECT behaviour: green = no bug, red = bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageData, emptyPage } from "../model/PageData";

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

function emptyInline(id: string): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	return p;
}

let fake: FakeAdapter;
let store: PageStore;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	fake = new FakeAdapter();
	store = new PageStore({ vault: { adapter: fake } }, ".handwriting", () => 5_000_000);
});

afterEach(() => {
	consoleError.mockRestore();
	vi.useRealTimers();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2000);
}

/**
 * The stroke ids each trash generation of a page holds, oldest generation
 * first. Ordered by stamp, then counter, as the store's restore orders them:
 * two generations in one millisecond are `<id>-<stamp>.json` and
 * `<id>-<stamp>-2.json`, and a plain string sort puts the second first.
 */
function trashLabels(pageId: string): string[] {
	const prefix = `.handwriting/trash/${pageId}-`;
	const generation = (p: string): [number, number] => {
		const m = /^(\d+)(?:-(\d+))?\.json$/.exec(p.slice(prefix.length));
		return m ? [Number(m[1]), Number(m[2] ?? 1)] : [-1, -1];
	};
	return [...fake.files.keys()]
		.filter((p) => p.startsWith(prefix) && p.endsWith(".json"))
		.sort((a, b) => {
			const [sa, na] = generation(a);
			const [sb, nb] = generation(b);
			return sa - sb || na - nb;
		})
		.map((p) => labelOf(fake.files.get(p)));
}

/**
 * The same files, seen through an adapter that can enumerate a folder.
 * `restoreFromTrash` returns nothing without `list`, and FakeAdapter has none
 * (RecoveredAnnouncesTrashRestore.test.ts subclasses it for the same reason).
 * Only the store that reopens the note uses this view; the store under test
 * keeps the plain adapter.
 */
function listing(adapter: FakeAdapter): FakeAdapter {
	return Object.assign(Object.create(adapter) as FakeAdapter, {
		async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
			const prefix = dir.endsWith("/") ? dir : dir + "/";
			return { files: [...adapter.files.keys()].filter((p) => p.startsWith(prefix)), folders: [] };
		},
	});
}

function labelOf(text: string | undefined): string {
	return /"id":\s*"(older|newer|reborn)"/.exec(text ?? "")?.[1] ?? "?";
}

/**
 * The page is on disk as "older"; a save of "newer" is running, held at the
 * adapter, when the note is deleted. `failures` write calls fail from the
 * moment the held save is let go: the save itself, then any recycle.
 */
async function deleteDuringFailingSave(failures: number, newer: PageData = pageWith("p1", "newer")): Promise<void> {
	store.schedule("p1", pageWith("p1", "older"));
	await settle();
	let release!: () => void;
	fake.writeGate = new Promise<void>((r) => (release = r));
	store.schedule("p1", newer);
	await vi.advanceTimersByTimeAsync(800); // debounce fired; the write waits at the gate
	expect(fake.writeAttempts, "precondition: the newer save reached the adapter").toBeGreaterThan(0);
	fake.failWriteTimes = failures;
	const removal = store.remove("p1"); // the note is deleted
	fake.writeGate = null;
	release(); // the running write now fails
	await removal;
}

describe("late async: a running save that fails after the note was deleted", () => {
	it("control: the same running save, succeeding, leaves no live sidecar", async () => {
		store.schedule("p1", pageWith("p1", "older"));
		await settle();
		let release!: () => void;
		fake.writeGate = new Promise<void>((r) => (release = r));
		store.schedule("p1", pageWith("p1", "newer"));
		await vi.advanceTimersByTimeAsync(800);
		const removal = store.remove("p1");
		fake.writeGate = null;
		release();
		await removal;
		await settle();
		expect(fake.files.has(".handwriting/p1.json")).toBe(false);
	});

	it("a running save that fails after remove() does not bring the deleted note's sidecar back", async () => {
		await deleteDuringFailingSave(1);
		await settle(); // the retry timer, if one was armed
		// CORRECT: a deleted note has no live sidecar.
		expect(
			fake.files.has(".handwriting/p1.json"),
			"a live ink file came back for the deleted note"
		).toBe(false);
		expect(trashLabels("p1").length, "nothing was recycled").toBeGreaterThan(0);
	});

	it("the failed save's ink is in the trash as the newest generation, and a restored note opens it", async () => {
		await deleteDuringFailingSave(1);
		await settle();
		expect(trashLabels("p1"), "the trash does not hold the ink last drawn after the older copy").toEqual(["older", "newer"]);
		const restored = await new PageStore({ vault: { adapter: listing(fake) } }, ".handwriting", () => 5_000_000).load("p1");
		expect(restored?.data.strokes.map((s) => s.id), "the restored note opened an older state").toEqual(["newer"]);
	});

	it("a newer drawing queued behind the failing save when the note is deleted: the restored note opens it, and the failed save's ink is kept aside", async () => {
		store.schedule("p1", pageWith("p1", "older"));
		await settle();
		let release!: () => void;
		fake.writeGate = new Promise<void>((r) => (release = r));
		store.schedule("p1", pageWith("p1", "newer"));
		await vi.advanceTimersByTimeAsync(800); // debounce fired; the write waits at the gate
		expect(fake.writeAttempts, "precondition: the newer save reached the adapter").toBeGreaterThan(0);
		store.schedule("p1", pageWith("p1", "newest")); // drawn while the save waits; still queued
		fake.failWriteTimes = 1;
		const removal = store.remove("p1"); // the note is deleted
		fake.writeGate = null;
		release(); // the running write now fails
		await removal;
		await settle();
		expect(fake.files.has(".handwriting/p1.json"), "a live ink file came back for the deleted note").toBe(false);
		const restored = await new PageStore({ vault: { adapter: listing(fake) } }, ".handwriting", () => 5_000_000).load("p1");
		expect(restored?.data.strokes.map((s) => s.id), "the restored note opened an older state than the ink last drawn").toEqual(["newest"]);
		const kept = [...fake.files.keys()].filter((p) => /^\.handwriting\/trash\/p1-\d+(?:-\d+)?-[a-z]+\.json$/.test(p));
		expect(kept.map((p) => labelOf(fake.files.get(p))), "the failed save's ink was lost").toEqual(["newer"]);
	});

	it("a kept-aside copy whose first trash write fails is retried still kept aside, so a restore still opens the newer drawing", async () => {
		store.schedule("p1", pageWith("p1", "older"));
		await settle();
		let release!: () => void;
		fake.writeGate = new Promise<void>((r) => (release = r));
		store.schedule("p1", pageWith("p1", "newer"));
		await vi.advanceTimersByTimeAsync(800); // debounce fired; the write waits at the gate
		store.schedule("p1", pageWith("p1", "newest")); // drawn while the save waits; still queued
		fake.failWriteTimes = 1;
		// The first write of the kept-aside copy fails; its retry must keep the tag.
		const write = fake.write.bind(fake);
		let keptFailures = 1;
		fake.write = async (path: string, text: string) => {
			if (keptFailures > 0 && /p1-\d+(?:-\d+)?-[a-z]+\.json$/.test(path)) {
				keptFailures--;
				throw new Error("trash write failure");
			}
			return write(path, text);
		};
		const removal = store.remove("p1"); // the note is deleted
		fake.writeGate = null;
		release(); // the running write now fails
		await removal;
		await settle();
		expect(keptFailures, "precondition: the kept-aside write failed once").toBe(0);
		expect(fake.files.has(".handwriting/p1.json"), "a live ink file came back for the deleted note").toBe(false);
		const restored = await new PageStore({ vault: { adapter: listing(fake) } }, ".handwriting", () => 5_000_000).load("p1");
		expect(restored?.data.strokes.map((s) => s.id), "after a retry the restored note opened an older state").toEqual(["newest"]);
	});

	it("control: a save that fails with no delete is retried as before and lands live", async () => {
		store.schedule("p1", pageWith("p1", "older"));
		await settle();
		fake.failWriteTimes = 1;
		store.schedule("p1", pageWith("p1", "newer"));
		await settle();
		expect(labelOf(fake.files.get(".handwriting/p1.json")), "the failed save was not retried").toBe("newer");
		expect(trashLabels("p1")).toEqual([]);
	});

	it("an empty save that fails after the note was deleted writes nothing to the trash", async () => {
		await deleteDuringFailingSave(1, emptyInline("p1"));
		await settle();
		expect(fake.files.has(".handwriting/p1.json")).toBe(false);
		expect(trashLabels("p1"), "an empty page went to the trash").toEqual(["older"]);
	});

	it("the recycle gets the three retries the save had left, 1.5 s apart, and lands on the last one", async () => {
		const onWriteError = vi.fn();
		store.onWriteError = onWriteError;
		// The save, then the recycle and two of its retries, fail.
		await deleteDuringFailingSave(4);
		await vi.advanceTimersByTimeAsync(0);
		const attempts = fake.writeAttempts;
		await vi.advanceTimersByTimeAsync(1400);
		expect(fake.writeAttempts, "a recycle retry came sooner than a save retry would").toBe(attempts);
		await vi.advanceTimersByTimeAsync(200);
		expect(fake.writeAttempts, "no recycle retry at the save's spacing").toBe(attempts + 1);
		await settle();
		expect(trashLabels("p1"), "the failed save's ink was lost").toEqual(["older", "newer"]);
		expect(fake.files.has(".handwriting/p1.json"), "a recycle retry wrote a live file").toBe(false);
		expect(onWriteError).not.toHaveBeenCalled();
	});

	it("a recycle that fails every retry tells the user once and writes no live file", async () => {
		const onWriteError = vi.fn();
		store.onWriteError = onWriteError;
		await deleteDuringFailingSave(5);
		await settle();
		await settle();
		expect(trashLabels("p1")).toEqual(["older"]);
		expect(fake.files.has(".handwriting/p1.json"), "a recycle retry wrote a live file").toBe(false);
		expect(onWriteError, "the user was not told, or told more than once").toHaveBeenCalledTimes(1);
		expect(onWriteError.mock.calls[0]?.[0]).toBe("p1");
	});

	it("the page id coming back while a recycle retry waits: the retry writes only the trash, and the live page keeps its new ink", async () => {
		// The save and the first recycle fail; the retry waits 1.5 s.
		await deleteDuringFailingSave(2);
		await vi.advanceTimersByTimeAsync(0);
		// The note is restored, or the id is reused, and saves before the retry.
		store.schedule("p1", pageWith("p1", "reborn"));
		await vi.advanceTimersByTimeAsync(800);
		expect(labelOf(fake.files.get(".handwriting/p1.json")), "precondition: the returned page saved").toBe("reborn");
		await settle();
		expect(labelOf(fake.files.get(".handwriting/p1.json")), "the recycle retry changed the live page").toBe("reborn");
		expect(trashLabels("p1"), "the recycle retry did not land in the trash").toEqual(["older", "newer"]);
		const loaded = await new PageStore({ vault: { adapter: fake } }, ".handwriting", () => 5_000_000).load("p1");
		expect(loaded?.data.strokes.map((s) => s.id)).toEqual(["reborn"]);
	});
});
