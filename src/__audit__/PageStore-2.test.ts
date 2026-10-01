/**
 * Audit probe PageStore-2 (1.4.21, 1a05f62c). Read-only verification.
 *
 * Claim: flushDispatch (the visibilitychange/pagehide path) writes only
 * `<id>.json.tmp`. load() recovers a .tmp only when there is NO live sidecar
 * or the live one is damaged. For a page that already has a readable
 * sidecar, a freeze + kill after the sweep leaves old live file + newer tmp,
 * and load() returns the old live file, dropping the last batch.
 *
 * This asserts the CORRECT behaviour (the newer batch comes back), so it goes
 * red only if the bug is real. Preconditions are asserted so a green means
 * the trigger was actually driven.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore } from "../persistence/PageStore";
import { PageData, emptyPage, parsePage } from "../model/PageData";

// Same fake filesystem shape as src/persistence/PageStore.test.ts.
class FakeAdapter {
	files = new Map<string, string>();
	mtimes = new Map<string, number>();
	dirs = new Set<string>();
	clock = 1000;
	writeStarts: string[] = [];
	log: string[] = [];

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
		this.log.push(`write ${path}`);
	}
	async rename(from: string, to: string): Promise<void> {
		const f = this.files.get(from);
		if (f === undefined) throw new Error(`ENOENT ${from}`);
		this.files.delete(from);
		this.files.set(to, f);
		this.mtimes.set(to, this.mtimes.get(from) ?? ++this.clock);
		this.mtimes.delete(from);
		this.log.push(`rename ${from} -> ${to}`);
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

function stroke(label: string) {
	return {
		id: label,
		tool: "pen" as const,
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 0 },
		createdAt: 0,
	};
}

function pageWith(id: string, labels: string[]): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = labels.map(stroke) as PageData["strokes"];
	return p;
}

/** The disk exactly as a freeze left it: a fresh adapter no frozen chain can reach. */
function snapshot(src: FakeAdapter): FakeAdapter {
	const disk = new FakeAdapter();
	for (const [p, t] of src.files) disk.files.set(p, t);
	for (const [p, m] of src.mtimes) disk.mtimes.set(p, m);
	for (const d of src.dirs) disk.dirs.add(d);
	disk.clock = src.clock;
	return disk;
}

async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2000);
}

const trashClock = 5_000_000;

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("PageStore-2: background-flush .tmp beside an existing sidecar", () => {
	it("a relaunch after freeze+kill returns the batch the background flush put in the .tmp", async () => {
		// Session A: the page already has ink on disk (its first save landed).
		const diskA = new FakeAdapter();
		const a = new PageStore({ vault: { adapter: diskA } }, ".handwriting", () => trashClock);
		a.schedule("p1", pageWith("p1", ["old"]));
		await settle();
		expect(diskA.files.has(".handwriting/p1.json")).toBe(true);
		expect(parsePage(diskA.files.get(".handwriting/p1.json")!, "p1").data.strokes.map((s) => s.id)).toEqual(["old"]);

		// Session B: app launched, note opened (load pins the path), user draws
		// a new stroke, and the app is backgrounded inside the debounce.
		const diskB = snapshot(diskA);
		const b = new PageStore({ vault: { adapter: diskB } }, ".handwriting", () => trashClock);
		const loaded = await b.load("p1");
		expect(loaded?.damaged).toBeFalsy();
		expect(loaded?.data.strokes.map((s) => s.id)).toEqual(["old"]);
		b.schedule("p1", pageWith("p1", ["old", "new"]));
		diskB.writeStarts.length = 0;
		b.flushDispatch();
		// The freeze: not one await between the sweep and the snapshot.
		const frozen = snapshot(diskB);

		// PRECONDITION: the trigger state the finding describes - a readable,
		// OLD live sidecar plus a complete, NEWER .tmp beside it.
		// The freeze writes its own carrier,
		// <sidecar>.flush = { flushBase, page }, not the shared .tmp.
		expect(diskB.writeStarts).toEqual([".handwriting/p1.json.flush"]);
		expect(frozen.files.has(".handwriting/p1.json")).toBe(true);
		expect(frozen.files.has(".handwriting/p1.json.flush")).toBe(true);
		const liveOnDisk = parsePage(frozen.files.get(".handwriting/p1.json")!, "p1");
		const tmpOnDisk = parsePage(JSON.stringify(JSON.parse(frozen.files.get(".handwriting/p1.json.flush")!).page), "p1");
		expect(liveOnDisk.damaged).toBeFalsy();
		expect(liveOnDisk.data.strokes.map((s) => s.id)).toEqual(["old"]);
		expect(tmpOnDisk.damaged).toBeFalsy();
		expect(tmpOnDisk.data.strokes.map((s) => s.id)).toEqual(["old", "new"]);

		// Session C: the OS killed the frozen app; relaunch, open the note.
		const c = new PageStore({ vault: { adapter: frozen } }, ".handwriting", () => trashClock);
		const relaunched = await c.load("p1");
		expect(relaunched?.damaged).toBeFalsy();
		// CORRECT behaviour: the batch the background flush saved comes back.
		expect(relaunched?.data.strokes.map((s) => s.id)).toContain("new");
	});

	it("the next save does not destroy the only copy of the background batch", async () => {
		// Same trigger state, then the user draws once more after relaunch.
		const diskA = new FakeAdapter();
		const a = new PageStore({ vault: { adapter: diskA } }, ".handwriting", () => trashClock);
		a.schedule("p1", pageWith("p1", ["old"]));
		await settle();

		const diskB = snapshot(diskA);
		const b = new PageStore({ vault: { adapter: diskB } }, ".handwriting", () => trashClock);
		await b.load("p1");
		b.schedule("p1", pageWith("p1", ["old", "new"]));
		b.flushDispatch();
		const frozen = snapshot(diskB);
		expect(parsePage(JSON.stringify(JSON.parse(frozen.files.get(".handwriting/p1.json.flush")!).page), "p1").data.strokes.map((s) => s.id)).toEqual([
			"old",
			"new",
		]);

		const c = new PageStore({ vault: { adapter: frozen } }, ".handwriting", () => trashClock);
		const relaunched = await c.load("p1");
		const next = pageWith("p1", [...(relaunched?.data.strokes.map((s) => s.id) ?? []), "after"]);
		c.schedule("p1", next);
		await settle();

		// CORRECT behaviour: stroke "new" still exists somewhere on disk.
		const anywhere = [...frozen.files.entries()]
			.filter(([p]) => p.startsWith(".handwriting/") && p.includes("p1"))
			.some(([, text]) => {
				try {
					return parsePage(text, "p1").data.strokes.some((s) => s.id === "new");
				} catch {
					return false;
				}
			});
		expect(anywhere).toBe(true);
	});
});
