/**
 * Audit probe L-persist-1 (1.4.21, 1a05f62c). Read-only probe of the REAL
 * PageStore: does a background/freeze flush (flushDispatch) leave the newest
 * ink recoverable when the page ALREADY had a saved sidecar?
 *
 * Asserts the CORRECT behaviour (next launch shows the strokes drawn before
 * the freeze), so a red means the bug is real. The FakeAdapter is copied from
 * src/persistence/PageStore.test.ts (test scaffolding, not logic under test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore } from "../persistence/PageStore";
import { PageData, emptyPage } from "../model/PageData";

class FakeAdapter {
	files = new Map<string, string>();
	mtimes = new Map<string, number>();
	dirs = new Set<string>();
	clock = 1000;
	writeStarts: string[] = [];
	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.dirs.has(path);
	}
	async read(path: string): Promise<string> {
		const f = this.files.get(path);
		if (f === undefined) throw new Error(`ENOENT ${path}`);
		return f;
	}
	async write(path: string, data: string): Promise<void> {
		this.writeStarts.push(path);
		this.files.set(path, data);
		this.mtimes.set(path, ++this.clock);
	}
	async rename(from: string, to: string): Promise<void> {
		const f = this.files.get(from);
		if (f === undefined) throw new Error(`ENOENT ${from}`);
		this.files.delete(from);
		this.files.set(to, f);
		this.mtimes.set(to, this.mtimes.get(from) ?? ++this.clock);
		this.mtimes.delete(from);
	}
	async remove(path: string): Promise<void> {
		this.files.delete(path);
		this.mtimes.delete(path);
	}
	async mkdir(path: string): Promise<void> {
		this.dirs.add(path);
	}
	async stat(path: string): Promise<{ mtime: number } | null> {
		return this.files.has(path) ? { mtime: this.mtimes.get(path)! } : null;
	}
	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = path.endsWith("/") ? path : `${path}/`;
		const files: string[] = [];
		const folders = new Set<string>();
		let seen = this.dirs.has(path);
		for (const p of this.files.keys()) {
			if (!p.startsWith(prefix)) continue;
			seen = true;
			const rest = p.slice(prefix.length);
			if (rest.includes("/")) folders.add(prefix + rest.split("/")[0]);
			else files.push(p);
		}
		if (!seen) throw new Error(`ENOENT ${path}`);
		return { files, folders: [...folders] };
	}
}

function pageWithLabels(id: string, labels: string[]): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = labels.map((label, i) => ({
		id: label,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 0, y: i * 10, pressure: 0.5, t: 0 },
			{ x: 10, y: i * 10, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: i * 10, width: 10, height: 0 },
		createdAt: i,
	})) as PageData["strokes"];
	return p;
}

/** The disk exactly as the freeze left it, on a fresh adapter (next launch). */
function copyDisk(src: FakeAdapter): FakeAdapter {
	const disk = new FakeAdapter();
	for (const [p, t] of src.files) disk.files.set(p, t);
	for (const [p, m] of src.mtimes) disk.mtimes.set(p, m);
	for (const d of src.dirs) disk.dirs.add(d);
	disk.clock = src.clock + 100;
	return disk;
}

const newStore = (adapter: FakeAdapter) =>
	new PageStore({ vault: { adapter } } as never, ".handwriting", () => 5_000_000);

async function drain(): Promise<void> {
	for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2000);
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
});
afterEach(() => {
	vi.useRealTimers();
});

describe("L-persist-1: freeze flush on a page that already has a sidecar", () => {
	it("control: no prior sidecar -> next launch recovers the freeze tmp (mechanism works here)", async () => {
		const fake = new FakeAdapter();
		const s = newStore(fake);
		s.schedule("p1", pageWithLabels("p1", ["fresh"]));
		s.flushDispatch(); // freeze: no await
		// The freeze writes its own carrier,
		// <sidecar>.flush = { flushBase, page }, not the shared .tmp.
		expect([...fake.files.keys()]).toEqual([".handwriting/p1.json.flush"]);
		const r = await newStore(copyDisk(fake)).load("p1");
		expect(r?.damaged).toBeFalsy();
		expect(r?.data.strokes.map((x) => x.id)).toEqual(["fresh"]);
	});

	it("existing sidecar -> next launch shows the strokes drawn before the freeze", async () => {
		// Session 1: the page gets saved ink normally.
		const fake = new FakeAdapter();
		const s1 = newStore(fake);
		s1.schedule("p1", pageWithLabels("p1", ["old"]));
		await s1.flush();
		await drain();
		expect(fake.files.has(".handwriting/p1.json")).toBe(true);
		expect(fake.files.has(".handwriting/p1.json.tmp")).toBe(false);

		// Session 2: open the page (load pins the live path), draw one more
		// stroke, then the app is backgrounded inside the debounce window.
		const s2 = newStore(fake);
		const loaded = await s2.load("p1");
		expect(loaded?.data.strokes.map((x) => x.id)).toEqual(["old"]);
		s2.schedule("p1", pageWithLabels("p1", ["old", "new"]));
		s2.flushDispatch(); // visibilitychange hidden -> flushOnHide; the freeze lands here

		// PRECONDITION of the claim: on disk sit the OLD valid live file and
		// a COMPLETE newer tmp beside it, and nothing else was written.
		const disk = copyDisk(fake);
		// The freeze writes its own carrier,
		// <sidecar>.flush = { flushBase, page }, not the shared .tmp.
		expect(fake.writeStarts.at(-1)).toBe(".handwriting/p1.json.flush");
		expect(JSON.parse(disk.files.get(".handwriting/p1.json")!).strokes.map((x: { id: string }) => x.id)).toEqual([
			"old",
		]);
		expect(JSON.parse(disk.files.get(".handwriting/p1.json.flush")!).page.strokes.map((x: { id: string }) => x.id)).toEqual([
			"old",
			"new",
		]);

		// Next launch (app was killed while suspended).
		const s3 = newStore(disk);
		const r = await s3.load("p1");
		expect(r?.damaged).toBeFalsy();
		// CORRECT behaviour: the stroke drawn before backgrounding is shown.
		expect(r?.data.strokes.map((x) => x.id)).toEqual(["old", "new"]);
	});

	it("existing sidecar -> the next session's first save does not destroy the only copy of the freeze-time stroke", async () => {
		const fake = new FakeAdapter();
		const s1 = newStore(fake);
		s1.schedule("p1", pageWithLabels("p1", ["old"]));
		await s1.flush();
		await drain();
		const s2 = newStore(fake);
		await s2.load("p1");
		s2.schedule("p1", pageWithLabels("p1", ["old", "new"]));
		s2.flushDispatch();
		const disk = copyDisk(fake);
		expect(disk.files.get(".handwriting/p1.json.flush")).toContain('"new"');

		// Next launch: load what load() gives, add one stroke to it, save.
		const s3 = newStore(disk);
		const r = await s3.load("p1");
		const ids = r!.data.strokes.map((x) => x.id);
		s3.schedule("p1", pageWithLabels("p1", [...ids, "later"]));
		await s3.flush();
		await drain();

		// CORRECT behaviour: stroke "new" survives somewhere on disk.
		const holders = [...disk.files.entries()].filter(([, t]) => t.includes('"new"')).map(([p]) => p);
		expect(holders.length, `files holding stroke "new": ${JSON.stringify([...disk.files.keys()])}`).toBeGreaterThan(0);
	});
});
