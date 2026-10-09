import { describe, expect, it } from "vitest";
import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";

// A refused rename re-queues the save, which arms the retry timer.
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

/**
 * Lands `armed` just before adapter call number `at`, counted from when it is
 * armed, and refuses a rename onto an existing destination as Obsidian's
 * adapters do ("Destination file already exists!", obsidian-1.13.7.asar).
 * Replaces a hook on the guard's read of the live path, which the
 * move-then-judge guard (R5) no longer makes: this
 * lands the sync write at EVERY point of the save sequence instead of one.
 *
 * The save sequence ends when the .tmp is renamed into place. A write landing
 * after that replaces a finished save, as any later sync does; keeping the
 * revision it replaced is the next save's guard, not this sequence. Such a
 * slot is not landed (`late`), and the loop below stops there.
 */
class Interleave extends FakeAdapter {
	armed: { path: string; data: string } | null = null;
	at = -1;
	calls = 0;
	inPlace = false;
	late = false;
	private tick(): void {
		if (this.armed === null) return;
		if (this.inPlace) {
			this.armed = null;
			this.late = true;
			return;
		}
		if (this.calls++ !== this.at) return;
		this.externalWrite(this.armed.path, this.armed.data);
		this.armed = null;
	}
	override async exists(path: string): Promise<boolean> {
		this.tick();
		return super.exists(path);
	}
	override async read(path: string): Promise<string> {
		this.tick();
		return super.read(path);
	}
	override async write(path: string, data: string): Promise<void> {
		this.tick();
		return super.write(path, data);
	}
	override async rename(from: string, to: string): Promise<void> {
		this.tick();
		if (this.files.has(to)) throw new Error("Destination file already exists!");
		await super.rename(from, to);
		if (from.endsWith(".tmp")) this.inPlace = true;
	}
	override async remove(path: string): Promise<void> {
		this.tick();
		return super.remove(path);
	}
	override async stat(path: string): Promise<{ mtime: number } | null> {
		this.tick();
		return super.stat(path);
	}
	override async mkdir(path: string): Promise<void> {
		this.tick();
		return super.mkdir(path);
	}
}

/** Lands `armed` on the first `exists(path)` after `path` was renamed aside. */
class SyncLandsAfterAside extends FakeAdapter {
	armed: { path: string; data: string } | null = null;
	private movedAside = false;
	override async rename(from: string, to: string): Promise<void> {
		await super.rename(from, to);
		if (this.armed && from === this.armed.path) this.movedAside = true;
	}
	override async exists(path: string): Promise<boolean> {
		if (this.armed && this.movedAside && path === this.armed.path) {
			this.externalWrite(this.armed.path, this.armed.data);
			this.armed = null;
		}
		return super.exists(path);
	}
}

function strokeIdsEverywhere(fake: FakeAdapter): { path: string; ids: string[] }[] {
	return [...fake.files.entries()]
		.filter(([p]) => p.startsWith(".handwriting/X"))
		.map(([path, text]) => ({ path, ids: parsePage(text, "X").data.strokes.map((s) => s.id) }));
}

describe("a sync write landing inside the save sequence is never deleted", () => {
	it("at every adapter call of the save, both revisions survive (rename refuses an existing destination)", async () => {
		const LIVE = ".handwriting/X.json";
		const run = async (at: number): Promise<{ landed: boolean; files: { path: string; ids: string[] }[] }> => {
			const fake = new Interleave();
			fake.dirs.add(".handwriting");
			fake.externalWrite(LIVE, serializePage(pageOf("X", "base")));
			const store = new PageStore({ vault: { adapter: fake } });
			await store.load("X");
			fake.calls = 0;
			fake.at = at;
			fake.armed = { path: LIVE, data: serializePage(pageOf("X", "base", "other-device")) };
			await store.saveNow("X", pageOf("X", "base", "mine"));
			const landed = fake.armed === null && !fake.late;
			fake.armed = null;
			// A refused rename re-queues the save; the next flush is its retry.
			await store.flush();
			return { landed, files: strokeIdsEverywhere(fake) };
		};
		const lost: string[] = [];
		let slots = 0;
		for (let at = 0; at < 64; at++) {
			const { landed, files } = await run(at);
			if (!landed) break; // past the save's last adapter call
			slots++;
			const mine = files.some((f) => f.ids.includes("mine"));
			const theirs = files.some((f) => f.ids.includes("other-device"));
			if (!mine || !theirs) lost.push(`call ${at}: ${JSON.stringify(files)}`);
		}
		expect(slots, "precondition: the sync write landed inside the save at least once").toBeGreaterThan(3);
		expect(lost, "a revision was lost when the sync write landed at these calls").toEqual([]);
	});

	it("after the guard moved an earlier external revision aside", async () => {
		const fake = new SyncLandsAfterAside();
		fake.dirs.add(".handwriting");
		fake.externalWrite(".handwriting/X.json", serializePage(pageOf("X", "base")));
		const store = new PageStore({ vault: { adapter: fake } });
		await store.load("X");
		fake.externalWrite(".handwriting/X.json", serializePage(pageOf("X", "base", "first-sync")));
		fake.armed = { path: ".handwriting/X.json", data: serializePage(pageOf("X", "base", "first-sync", "second-sync")) };
		await store.saveNow("X", pageOf("X", "base", "mine"));
		expect(fake.armed).toBeNull();

		const files = strokeIdsEverywhere(fake);
		expect(files.some((f) => f.ids.includes("first-sync")), JSON.stringify(files)).toBe(true);
		expect(files.some((f) => f.ids.includes("second-sync")), JSON.stringify(files)).toBe(true);
	});
});
