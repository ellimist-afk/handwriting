/**
 * A NOTE OPENED AGAIN WHILE ANOTHER PANE IS MID-ERASE: THE OTHER DEVICE'S NEW
 * STROKE MUST SURVIVE ON DISK.
 *
 * The regular sync check refuses to take another device's revision while a
 * pane is busy or a save is queued. Opening the note again (a second pane, a
 * switch back, an embed) takes the same revision through a second route whose
 * only condition is that the ink did not change while it waited.
 *
 * Here this device has erased stroke "erased-here" with the pen still down (removed in
 * memory, not saved). The other device added stroke "added-elsewhere" and its file lands.
 * The note is opened again; while the adoption is being prepared, the pen
 * lifts and the erase is saved. The save was queued from the page before the
 * adoption, and once the adoption is accepted the store takes the other
 * device's file for its own last write, so the queued save replaces it with
 * no copy kept. "added-elsewhere" is then on disk nowhere.
 *
 * Real InlineInkStore and PageStore over a fake adapter; the only hook is a
 * pause inside the adoption's preparation, where the lift lands.
 */
import { expect, it } from "vitest";

(globalThis as { window?: unknown }).window ??= globalThis;

import { PageStore } from "../persistence/PageStore";
import { FakeAdapter, gate } from "../persistence/FakeAdapter";
import { InlineInkStore } from "./InlineInkStore";
import { emptyPage, serializePage, type PageData } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const PATH = "reopen.md", PAGE_ID = "reopen-page", FOLDER = ".handwriting";
const LIVE = `${FOLDER}/${PAGE_ID}.json`;

function stroke(id: string): InkStroke {
	return { id, tool: "pen", color: "#123456", width: 2, createdAt: 1,
		points: [{ x: 10, y: 20, pressure: .5, t: 0 }, { x: 30, y: 40, pressure: .7, t: 10 }],
		bbox: { x: 10, y: 20, width: 20, height: 20 } };
}
function page(ids: string[]): PageData {
	return { ...emptyPage(PAGE_ID), surface: "inline", strokes: ids.map(stroke) };
}

async function rig(liftDuringPrepare: boolean, panesBusy = false) {
	const fake = new FakeAdapter();
	fake.dirs.add(FOLDER);
	fake.externalWrite(LIVE, serializePage(page(["erased-here"])));
	const store = new PageStore({ vault: { adapter: fake } } as never, FOLDER, () => 5_000_000);
	const ink = new InlineInkStore();
	const pause = gate();
	let entered!: () => void;
	const inPrepare = new Promise<void>(r => { entered = r; });
	let prepares = 0;
	ink.attachHost({
		readPageId: (p: string) => (p === PATH ? PAGE_ID : null),
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: (id: string) => store.load(id),
		scheduleSidecar: (id: string, p: PageData) => store.schedule(id, p),
		scheduleSidecarNow: (id: string, p: PageData) => store.saveNow(id, p),
		sidecarChanged: (id: string) => store.externallyChanged(id),
		hasQueuedWrite: (id: string) => store.hasQueuedWrite(id),
		panesQuiet: () => !panesBusy,
		prepareExternalAdoption: async (id: string, outgoing: PageData) => {
			prepares++;
			entered();
			await pause.promise;
			return store.prepareExternalAdoption(id, outgoing);
		},
		acceptExternalAdoption: (prepared: never) => store.acceptExternalAdoption(prepared),
		notify() {},
	} as never);
	await ink.ensureLoaded(PATH);
	expect(ink.strokes(PATH).map(s => s.id), "the note did not load its ink").toEqual(["erased-here"]);
	// The eraser takes "erased-here" with the pen still down: removed in memory, nothing saved.
	ink.takeLive(PATH, ["erased-here"]);
	// The other device added "added-elsewhere"; its file lands.
	fake.externalWrite(LIVE, serializePage(page(["erased-here", "added-elsewhere"])));
	// The note is opened again in a second pane.
	const reopen = ink.ensureLoaded(PATH);
	await Promise.race([inPrepare, reopen]);
	if (!panesBusy) expect(prepares, "the reopen never tried to take the other device's revision, so this cell proves nothing").toBe(1);
	// The pen lifts while the adoption is being prepared: the erase is saved.
	if (liftDuringPrepare) ink.save(PATH);
	pause.release();
	await reopen;
	await ink.settle();
	await store.flush();
	return { fake, ink, everything: [...fake.files.values()].join("\n") };
}

it("control: with no lift during the reopen, the other device's stroke is on disk", async () => {
	const { everything } = await rig(false);
	expect(everything).toContain("added-elsewhere");
});

it("an erase saved while the reopen prepares does not wipe the other device's stroke from disk", async () => {
	const { everything } = await rig(true);
	expect(everything, "the other device's stroke is on disk nowhere, live or as a copy").toContain("added-elsewhere");
});

it("a reopen while a pane on the note is drawing or erasing takes nothing: the other device's file waits on disk", async () => {
	const { ink, everything } = await rig(false, true);
	expect(ink.strokes(PATH).map(s => s.id), "the reopen adopted another device's file under a busy pane").not.toContain("added-elsewhere");
	expect(everything, "the other device's stroke is on disk").toContain("added-elsewhere");
});
