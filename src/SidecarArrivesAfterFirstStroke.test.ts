/**
 * THE NOTE ARRIVES BEFORE ITS INK FILE, AND THIS DEVICE DRAWS IN THE GAP.
 *
 * Another device drew in a note and both files sync over. The markdown,
 * carrying the page id, lands first; this device opens the note, finds no ink
 * file, and draws one stroke. The other device's ink file then lands before
 * this device's save runs. The save's guard sees a file it never read, moves
 * it to `<id>.conflict-<mtime>.json` and publishes this device's one stroke as
 * the live page. The other device then adopts that page, so the note shows
 * only the stroke drawn in the gap, on both devices.
 *
 * Two revisions that each hold ink the other lacks are a fork, and the answer
 * to a fork is the user's choice, not a merge. So the copy moved aside must be
 * offered by the fix ink de-sync list, holding the other device's stroke, and
 * choosing it must make it the live page. The list only scanned
 * `.conflict-external-` pairs, so it never saw this copy. The existing
 * two-device test of this order asserts that every stroke survives somewhere
 * in the folder, not that anything lists the copy.
 *
 * Real PageStore, InlineInkStore and fork scan over a fake adapter; only
 * transport is faked.
 */
import { afterEach, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window ??= globalThis;

import { PageStore } from "./persistence/PageStore";
import { FakeAdapter } from "./persistence/FakeAdapter";
import { InlineInkStore } from "./inline/InlineInkStore";
import { applyForkDecision, describeFork, forkHostFor, listForks, refreshForks, resetForks } from "./persistence/ForkResolution";
import { emptyPage, parsePage, serializePage } from "./model/PageData";
import type { InkStroke } from "./ink/Stroke";

vi.mock("obsidian", async original => ({ ...await original<object>(), Notice: class { constructor(_m: string) {} } }));

class ListingAdapter extends FakeAdapter {
	async list(path: string) {
		const prefix = path + "/";
		return { files: [...this.files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")),
			folders: [...this.dirs].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) };
	}
}

const notePath = "Arrives.md", noteId = "arrives-note", folder = "handwriting";
const live = `${folder}/${noteId}.json`;

function stroke(id: string): InkStroke {
	return { id, tool: "pen", color: "#123456", width: 2, createdAt: 1,
		points: [{ x: 10, y: 20, pressure: .5, t: 0 }, { x: 30, y: 40, pressure: .7, t: 10 }],
		bbox: { x: 10, y: 20, width: 20, height: 20 } };
}

/** Markdown here, ink file not yet; one stroke drawn; the other device's file lands; the save runs. */
async function drawInTheGap() {
	const files = new ListingAdapter();
	files.externalWrite(notePath, `---\nhandwriting-page-id: ${noteId}\n---\nText`);
	files.dirs.add(folder);
	const store = new PageStore({ vault: { adapter: files } } as never);
	store.useInkFolder(folder);
	const ink = new InlineInkStore();
	ink.attachHost({
		readPageId: path => files.files.get(path)?.match(/handwriting-page-id: ([^\n]+)/)?.[1] ?? null,
		claimId: async () => ({ pageId: noteId }), loadSidecar: id => store.load(id),
		scheduleSidecar: (id, data) => store.schedule(id, data), scheduleSidecarNow: (id, data) => store.saveNow(id, data),
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing),
		acceptExternalAdoption: prepared => store.acceptExternalAdoption(prepared), notify() {},
	});
	await ink.ensureLoaded(notePath);
	expect(ink.strokes(notePath), "the note had ink before the gap, so this cell proves nothing").toEqual([]);
	expect(files.files.has(live), "the ink file was already here").toBe(false);
	ink.commit(notePath, stroke("drawn-in-gap"));
	files.externalWrite(live, serializePage({ ...emptyPage(noteId), surface: "inline", strokes: [stroke("other-device")] }));
	await ink.settle(); await store.flush();
	const everything = [...files.files.values()].join("\n");
	expect(everything, "a stroke was lost outright, not only displaced").toContain("other-device");
	expect(everything).toContain("drawn-in-gap");
	return { files, store };
}

afterEach(() => resetForks());

it("the other device's ink moved aside is listed by fix ink de-sync as a fork holding its stroke", async () => {
	const { files, store } = await drawInTheGap();
	const host = forkHostFor({ adapter: files, store } as never);
	resetForks();
	await refreshForks(host, folder);
	const rec = listForks().find(r => r.pageId === noteId);
	expect(rec, "the other device's ink sits in a copy nothing lists").toBeDefined();
	const account = await describeFork(host, rec!);
	expect(account.theirs.readable, "the listed copy cannot be read").toBe(true);
	expect(parsePage(files.files.get(rec!.incomingPath)!, noteId).data.strokes.map(s => s.id), "the listed copy is not the other device's ink").toEqual(["other-device"]);
	expect(account.needsDecision, "the fork is listed but not put to the user").toBe(true);
});

it("choosing the other device's ink from that list makes it the live page", async () => {
	const { files, store } = await drawInTheGap();
	const host = forkHostFor({ adapter: files, store } as never);
	resetForks();
	await refreshForks(host, folder);
	const rec = listForks().find(r => r.pageId === noteId);
	expect(rec, "the other device's ink sits in a copy nothing lists").toBeDefined();
	const out = await applyForkDecision(host, rec!, "take-theirs");
	expect(out.kind, `the decision was refused: ${out.why}`).toBe("applied");
	expect(parsePage(files.files.get(live)!, noteId).data.strokes.map(s => s.id), "the live page is not the other device's ink").toEqual(["other-device"]);
	resetForks();
	await refreshForks(host, folder);
	expect(listForks().filter(r => r.pageId === noteId), "a decided fork is listed again").toEqual([]);
	const everything = [...files.files.values()].join("\n");
	expect(everything, "the stroke drawn here was deleted by the decision").toContain("drawn-in-gap");
});
