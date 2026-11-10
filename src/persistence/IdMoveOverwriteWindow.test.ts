/**
 * AN ID MOVE MUST NOT WRITE OVER OR DELETE A FILE THAT LANDS WHILE IT RUNS.
 *
 * keepAsideUnder moves the ink of a note whose page id changed from the old
 * id's file to the new id's path. When the new id has no live file yet, or
 * its live file is still the one an earlier round of the same move wrote,
 * the move reads the old file, writes it to the new id's path and removes the
 * old file. A sync tool can land a file during those awaits. These cells hold
 * the move's write open, land a foreign revision, then let the write go:
 *
 * - first round, the new id has no live file: a revision of the new id's file
 *   that lands during the write is kept, live or as a copy;
 * - a later round, the new id's live file is the move's own: a revision of
 *   the new id's file that lands during the write is kept, live or as a copy;
 * - a revision of the old id's file that lands after the move read it and
 *   before it removed it is kept beside the new id, live or as a copy; left
 *   at the old id's path, which nothing names, it is not kept;
 * - a move whose last rename of its tmp into the new id's path fails throws,
 *   and the ink is still at the old id's path, the new id's live file or a
 *   copy beside it;
 * - a save of the new id whose write lands between the move's write and its
 *   rename into place: the ink drawn here and the save's ink are both kept
 *   under the new id, live or as a copy;
 * - the other order: the save's write lands first and its rename after the
 *   whole move: both inks are kept the same way.
 *
 * The rename onto an existing file is refused here, as the desktop adapter
 * refuses it. Real pieces: PageStore and its id move. Synthetic: FakeAdapter
 * and the foreign landings. Not device acceptance, not real sync timing.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore, contentStamp } from "./PageStore";
import { FakeAdapter, gate } from "./FakeAdapter";
import { type PageData, emptyPage, parsePage, serializePage } from "../model/PageData";

const g = globalThis as { window?: unknown };
g.window ??= globalThis;

const OLD = "own-page-id";
const NEW = "edited-page-id";
const DIR = ".handwriting";
const sidecarPath = (id: string): string => `${DIR}/${id}.json`;

function pageOf(id: string, ...strokeIds: string[]): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = strokeIds.map((sid, i) => ({
		id: sid,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: i * 20, y: 0, pressure: 0.5, t: 0 },
			{ x: i * 20 + 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: i * 20, y: 0, width: 10, height: 0 },
		createdAt: i,
	})) as PageData["strokes"];
	return p;
}

/** Lets queued microtasks run, up to `turns` of them, until `cond` holds; answers whether it held. No timer, no wait. */
async function settleUntil(cond: () => boolean, turns = 2000): Promise<boolean> {
	for (let i = 0; i < turns && !cond(); i++) await Promise.resolve();
	return cond();
}

/** The old id's file on disk with `strokes`; the store has nothing queued. The rename refusal is on. */
function setup(...strokes: string[]): { store: PageStore; fake: FakeAdapter } {
	const fake = new FakeAdapter();
	fake.dirs.add(DIR);
	fake.refuseRenameOntoFile = true;
	fake.externalWrite(sidecarPath(OLD), serializePage(pageOf(OLD, ...strokes)));
	const store = new PageStore({ vault: { adapter: fake } } as never, DIR, () => 5000);
	return { store, fake };
}

/** Every stroke id in every file under the ink folder, as `path: ids`. */
function strokesOnDisk(fake: FakeAdapter): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const [path, text] of fake.files) {
		if (!path.startsWith(`${DIR}/`) || !path.endsWith(".json")) continue;
		const parsed = parsePage(text, NEW);
		out.set(path, parsed.data.strokes.map((s) => s.id).sort());
	}
	return out;
}

/** Stroke ids in the new id's live file and its copies only. */
function keptUnderNew(fake: FakeAdapter): string[] {
	const ids: string[] = [];
	for (const [path, s] of strokesOnDisk(fake)) {
		if (path === sidecarPath(NEW) || path.startsWith(`${DIR}/${NEW}.conflict-`)) ids.push(...s);
	}
	return ids;
}

/**
 * Runs keepAsideUnder with the move's first write held at the adapter; `land` runs while it is held, then the write
 * goes on. Answers the move's result, or the error it threw.
 */
async function moveWithLanding(
	store: PageStore,
	fake: FakeAdapter,
	land: () => void,
	own?: string
): Promise<{ result?: Awaited<ReturnType<PageStore["keepAsideUnder"]>>; error?: unknown }> {
	const held = gate();
	const before = fake.writeAttempts;
	fake.writeGate = held.promise;
	const moved = store.keepAsideUnder(OLD, NEW, own).then(
		(result) => ({ result }),
		(error: unknown) => ({ error })
	);
	expect(await settleUntil(() => fake.writeAttempts === before + 1), "premise: the move's write reached the adapter and is held").toBe(true);
	land();
	fake.writeGate = null;
	held.release();
	return moved;
}

describe("an id move keeps a file that lands while it runs", () => {
	it("first round, no live file under the new id: a revision of the new id's file landing during the move's write is kept", async () => {
		const { store, fake } = setup("mine");
		const theirs = serializePage(pageOf(NEW, "drawn-there"));
		const out = await moveWithLanding(store, fake, () => fake.externalWrite(sidecarPath(NEW), theirs));
		const files = Object.fromEntries(strokesOnDisk(fake));
		expect(keptUnderNew(fake), `the other device's revision was written over (files ${JSON.stringify(files)}, result ${JSON.stringify(out)})`).toContain("drawn-there");
		expect(keptUnderNew(fake), `the ink drawn here left the new id's files (files ${JSON.stringify(files)})`).toContain("mine");
	});

	it("later round, the new id's live file is the move's own: a revision of it landing during the move's write is kept", async () => {
		const { store, fake } = setup("mine");
		const first = await store.keepAsideUnder(OLD, NEW);
		expect(first.kind === "moved" && first.to === sidecarPath(NEW), "premise: the first round made the old file the new id's live file").toBe(true);
		const own = first.kind === "moved" ? first.stamp : undefined;
		expect(own, "premise: the first round answered the stamp of what it wrote").toBeDefined();
		// The note saved again under the old id between the rounds.
		fake.externalWrite(sidecarPath(OLD), serializePage(pageOf(OLD, "mine", "between")));
		expect(contentStamp(fake.files.get(sidecarPath(NEW))!), "premise: the new id's live file is still the first round's own").toBe(own);
		const theirs = serializePage(pageOf(NEW, "drawn-there"));
		const out = await moveWithLanding(store, fake, () => fake.externalWrite(sidecarPath(NEW), theirs), own);
		const files = Object.fromEntries(strokesOnDisk(fake));
		expect(keptUnderNew(fake), `the other device's revision was written over (files ${JSON.stringify(files)}, result ${JSON.stringify(out)})`).toContain("drawn-there");
		expect(keptUnderNew(fake), `the ink drawn here left the new id's files (files ${JSON.stringify(files)})`).toEqual(expect.arrayContaining(["mine", "between"]));
	});

	it("a revision of the old id's file landing after the move read it and before it removed it is kept beside the new id", async () => {
		const { store, fake } = setup("mine");
		const late = serializePage(pageOf(OLD, "mine", "late-old"));
		const out = await moveWithLanding(store, fake, () => fake.externalWrite(sidecarPath(OLD), late));
		const files = Object.fromEntries(strokesOnDisk(fake));
		// Left at the old id's path it is on disk but nothing names it: only the new id's live file or a copy beside it counts.
		expect(keptUnderNew(fake), `the late revision of the old id's file is not in the new id's files (files ${JSON.stringify(files)}, result ${JSON.stringify(out)})`).toContain("late-old");
		expect(keptUnderNew(fake), `the ink drawn here left the new id's files (files ${JSON.stringify(files)})`).toContain("mine");
	});

	it("a move whose last rename into the new id's path fails keeps the ink at a path the note can still reach", async () => {
		const { store, fake } = setup("mine");
		fake.failRenameTimes = 1;
		// The move's tmp, whatever it is named, renamed onto the new id's path.
		fake.failRenameWhen = (from, to) => from.endsWith(".json.tmp") && to === sidecarPath(NEW);
		const out = await store.keepAsideUnder(OLD, NEW).then(
			(result) => ({ result }),
			(error: unknown) => ({ error })
		);
		expect(fake.failRenameTimes, "premise: the move reached the rename of its tmp into the new id's path, and it failed").toBe(0);
		expect("error" in out, `premise: the move threw on the failed rename (result ${JSON.stringify(out)})`).toBe(true);
		const onDisk = strokesOnDisk(fake);
		const files = Object.fromEntries(onDisk);
		// Reachable: the old id's path, the new id's live file, or a copy beside it. Anywhere else nothing names it.
		const reachable: string[] = [];
		for (const [path, s] of onDisk) {
			if (path === sidecarPath(OLD) || path === sidecarPath(NEW) || path.startsWith(`${DIR}/${NEW}.conflict-`)) reachable.push(...s);
		}
		expect(reachable, `the ink drawn here is at no path the note can reach (files ${JSON.stringify(files)})`).toContain("mine");
	});

	it("a save of the new id whose write lands between the move's write and its rename into place keeps both inks", async () => {
		const { store, fake } = setup("mine");
		const newTmp = `${sidecarPath(NEW)}.tmp`;
		const write = fake.write.bind(fake);
		const rename = fake.rename.bind(fake);
		const saveHeld = gate();
		let saveWrote = false;
		let saving: Promise<unknown> | null = null;
		// The save of the new id stops after its write of the new id's tmp, until the move has renamed its file into place.
		vi.spyOn(fake, "write").mockImplementation(async (p: string, d: string) => {
			await write(p, d);
			if (p === newTmp && d.includes("saved-new") && !saveWrote) {
				saveWrote = true;
				await saveHeld.promise;
			}
		});
		// The move's rename into the new id's path waits until that save's write has landed.
		vi.spyOn(fake, "rename").mockImplementation(async (from: string, to: string) => {
			if (saving === null && to === sidecarPath(NEW)) {
				saving = store.saveNow(NEW, pageOf(NEW, "saved-new")).catch((error: unknown) => error);
				expect(await settleUntil(() => saveWrote), "premise: the new id's save wrote before the move's rename").toBe(true);
			}
			return rename(from, to);
		});
		const out = await store.keepAsideUnder(OLD, NEW).then(
			(result) => ({ result }),
			(error: unknown) => ({ error })
		);
		expect(saving, "premise: the move reached its rename into the new id's path").not.toBeNull();
		saveHeld.release();
		await saving;
		const files = Object.fromEntries(strokesOnDisk(fake));
		expect(keptUnderNew(fake), `the ink drawn here left the new id's files (files ${JSON.stringify(files)}, result ${JSON.stringify(out)})`).toContain("mine");
		expect(keptUnderNew(fake), `the new id's save left the new id's files (files ${JSON.stringify(files)}, result ${JSON.stringify(out)})`).toContain("saved-new");
	});

	it("a save of the new id whose write lands before the move's write and renames after the move keeps both inks", async () => {
		const { store, fake } = setup("mine");
		const newTmp = `${sidecarPath(NEW)}.tmp`;
		const write = fake.write.bind(fake);
		const saveHeld = gate();
		let saveWrote = false;
		// The save of the new id stops after its write of the new id's tmp, until the move has run to its end.
		vi.spyOn(fake, "write").mockImplementation(async (p: string, d: string) => {
			await write(p, d);
			if (p === newTmp && d.includes("saved-new") && !saveWrote) {
				saveWrote = true;
				await saveHeld.promise;
			}
		});
		const saving = store.saveNow(NEW, pageOf(NEW, "saved-new")).catch((error: unknown) => error);
		expect(await settleUntil(() => saveWrote), "premise: the new id's save wrote its tmp before the move began").toBe(true);
		const out = await store.keepAsideUnder(OLD, NEW).then(
			(result) => ({ result }),
			(error: unknown) => ({ error })
		);
		saveHeld.release();
		await saving;
		const files = Object.fromEntries(strokesOnDisk(fake));
		expect(keptUnderNew(fake), `the ink drawn here left the new id's files (files ${JSON.stringify(files)}, result ${JSON.stringify(out)})`).toContain("mine");
		expect(keptUnderNew(fake), `the new id's save left the new id's files (files ${JSON.stringify(files)}, result ${JSON.stringify(out)})`).toContain("saved-new");
	});
});
