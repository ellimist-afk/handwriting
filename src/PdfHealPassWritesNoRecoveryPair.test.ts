/**
 * The live-reload poll heals a PDF that was opened while its ink file was mid-sync: once the file reads again, the
 * locked record is read again and ink drawn under the lock is queued to save. Went on to the adoption in that same
 * pass, it found the record holding a stroke the file lacks and wrote a recovery pair beside the ink file - two
 * files that sync, and a false entry in "fix ink de-sync" on every device. These cells run the production poll and
 * the production PDF host over a real page store: the pass that reached a locked record prepares no adoption, and
 * the passes while its save is on the way prepare none either; a real fork on an unlocked PDF still gets its pair.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformSync } from "esbuild";
import pluginSettingsSource from "./settings/PluginSettings.ts?raw";
import { PageStore } from "./persistence/PageStore";
import { FakeAdapter } from "./persistence/FakeAdapter";
import { emptyPage, parsePage, serializePage, type PageData } from "./model/PageData";
import { PdfInkStore } from "./pdf/PdfInkStore";
import { installLiveReloadPoll } from "./testUtils/LiveReloadTestHarness";
import type { InkStroke } from "./ink/Stroke";

const PDF_ID = "pdf-a1b2c3d4";
const PATH = `.handwriting/${PDF_ID}.json`;
const TRUNCATED = '{"surface":"pdf","strokes":[';

// The production host registration, executed from settings/PluginSettings.ts source (as the damage-lock audit
// suite and PdfAdoptionRouteEndToEnd.test.ts do).
const source = pluginSettingsSource.replace(/\r\n/g, "\n");
const hostStart = source.indexOf("\t\tthis.pdfStore.attachHost({");
const hostEnd = source.indexOf("\n\t\t});\n", hostStart);
const installPdfPersistenceHost = new Function(
	"Notice",
	"blockNotice",
	transformSync(source.slice(hostStart, hostEnd + "\n\t\t});\n".length), { loader: "ts", target: "es2022" }).code
);

function stroke(id: string, x = 10): InkStroke {
	return {
		id, page: 1, tool: "pen", color: "#111111", width: 2, createdAt: 0,
		points: [
			{ x, y: 10, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x, y: 10, width: 10, height: 10 },
	};
}

function pdfPage(ids: string[]): PageData {
	const page = emptyPage(PDF_ID);
	page.surface = "pdf";
	page.coordSpace = "page-css@1";
	page.pdfPaths = ["Doc.pdf"];
	page.strokes = ids.map((id, i) => stroke(id, 10 + 40 * i));
	return page;
}

function rig(first: string) {
	const adapter = new FakeAdapter();
	adapter.externalWrite(PATH, first);
	const disk = new PageStore({ vault: { adapter } } as unknown as ConstructorParameters<typeof PageStore>[0]);
	const ink = new PdfInkStore();
	class SilentNotice { constructor(_m: string) {} }
	installPdfPersistenceHost.call({ pdfStore: ink, store: disk }, SilentNotice, (m: string) => new SilentNotice(m));
	const root = { isConnected: true };
	const controller = { idle: true, refresh: vi.fn() };
	let fire!: () => void;
	let pending = Promise.resolve();
	const host = {
		store: disk,
		pdfStore: ink,
		pdfInk: new Map([[root, controller]]),
		pdfIds: new Map([[root, PDF_ID]]),
		pollStats: { ticks: 0, hidden: 0, spaced: 0, checks: 0 },
		registerInterval: (h: number) => h,
	};
	installLiveReloadPoll.call(
		host,
		{ setInterval(fn: () => void) { fire = fn; return 1; } },
		{ hidden: false },
		(work: Promise<void>) => { pending = work.catch(() => {}); },
		() => [], {}, () => {}, () => {}, () => null, async () => false, { error: () => {} }, () => null,
	);
	const adopt = vi.spyOn(ink, "adoptExternal");
	const prepare = vi.spyOn(disk, "prepareExternalAdoption");
	return {
		adapter, disk, ink, controller, host, adopt, prepare,
		/** One poll pass; true when it checked the ink files (not spaced out by the idle backoff). */
		async tick(): Promise<boolean> {
			const checks = host.pollStats.checks;
			fire();
			await pending;
			return host.pollStats.checks > checks;
		},
		pairs: (): string[] => [...adapter.files.keys()].filter((p) => p.includes(".conflict-external-")),
		onFile: (): string[] => parsePage(adapter.files.get(PATH)!, PDF_ID).data.strokes.map((s) => s.id),
		onScreen: (): string[] => ink.strokes(PDF_ID).map((s) => s.id),
	};
}

/** Open the PDF mid-sync (locked), draw under the lock, then the sync client finishes writing `file`. */
async function lockedThenSynced(file: string[]) {
	const r = rig(TRUNCATED);
	await r.ink.ensureLoaded(PDF_ID);
	expect(r.ink.inkReady(PDF_ID), "precondition: the mid-sync read locked the PDF").toBe(false);
	r.ink.commit(PDF_ID, stroke("during", 200));
	r.adapter.externalWrite(PATH, serializePage(pdfPage(file)));
	return r;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("the poll pass that heals a locked PDF", () => {
	it("P1: the file still has no stroke: the pass calls no adoption and writes no recovery pair; the ink drawn under the lock is saved", async () => {
		const r = await lockedThenSynced([]);

		expect(await r.tick(), "precondition: the pass checked the ink file").toBe(true);

		expect(r.ink.inkReady(PDF_ID), "precondition: the pass read the file again and lifted the lock").toBe(true);
		expect(r.disk.hasQueuedWrite(PDF_ID), "precondition: the ink drawn under the lock is queued to save").toBe(true);
		// Soft, so one run shows each layer: the pair on disk, the preparation, the call.
		expect.soft(r.pairs(), "the pass that healed the PDF wrote a recovery pair").toEqual([]);
		expect.soft(r.prepare, "the pass that healed the PDF prepared an adoption").not.toHaveBeenCalled();
		expect.soft(r.adopt, "the pass that healed the PDF went on to an adoption").not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1000);
		await r.disk.flush();
		expect(r.onFile(), "the ink drawn under the lock was not saved").toEqual(["during"]);
	});

	it("P2: the file adds a stroke: the pass repaints, calls no adoption and writes no pair; the merged page is saved", async () => {
		const r = await lockedThenSynced(["remote"]);

		expect(await r.tick(), "precondition: the pass checked the ink file").toBe(true);

		expect(r.ink.inkReady(PDF_ID), "precondition: the lock is lifted").toBe(true);
		expect(r.controller.refresh, "the pane was not repainted with the file's stroke").toHaveBeenCalled();
		expect(r.adopt, "the pass that healed the PDF went on to an adoption").not.toHaveBeenCalled();
		expect(r.prepare).not.toHaveBeenCalled();
		expect(r.pairs()).toEqual([]);

		await vi.advanceTimersByTimeAsync(1000);
		await r.disk.flush();
		expect(r.onFile(), "the merged page was not saved").toEqual(["remote", "during"]);
	});

	it("P3: the passes after the heal, one before its save lands and one after, prepare no adoption either", async () => {
		const r = await lockedThenSynced([]);
		expect(await r.tick(), "precondition: the heal pass checked the ink file").toBe(true);
		expect(r.ink.inkReady(PDF_ID), "precondition: the lock is lifted").toBe(true);
		r.prepare.mockClear();
		r.adopt.mockClear();
		const pairsAfterHeal = r.pairs();

		expect(r.disk.hasQueuedWrite(PDF_ID), "precondition: the save is still queued").toBe(true);
		expect(await r.tick(), "precondition: the pass before the save lands checked the ink file").toBe(true);
		expect(r.prepare, "a pass while the save was queued prepared an adoption").not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1000);
		await r.disk.flush();
		expect(r.disk.hasQueuedWrite(PDF_ID), "precondition: the save has landed").toBe(false);
		expect(await r.tick(), "precondition: the pass after the save checked the ink file").toBe(true);

		expect(r.prepare, "a pass after the save landed prepared an adoption").not.toHaveBeenCalled();
		expect(r.adopt, "a pass after the save landed went on to an adoption").not.toHaveBeenCalled();
		expect(r.pairs(), "a pass after the heal wrote a recovery pair").toEqual(pairsAfterHeal);
		expect(r.onFile(), "the ink drawn under the lock was not saved").toEqual(["during"]);
	});

	it("PIN: a heal whose read is still unsound keeps the lock, prepares nothing and writes nothing", async () => {
		const r = await lockedThenSynced([]);
		r.adapter.externalWrite(PATH, `${TRUNCATED}{`);

		expect(await r.tick(), "precondition: the pass checked the ink file").toBe(true);
		await vi.advanceTimersByTimeAsync(1000);

		expect(r.ink.inkReady(PDF_ID), "a damaged read lifted the lock").toBe(false);
		expect(r.prepare, "a locked PDF prepared an adoption").not.toHaveBeenCalled();
		expect(r.pairs()).toEqual([]);
		expect(r.adapter.files.get(PATH), "the unreadable file was written over").toBe(`${TRUNCATED}{`);
		expect(r.onScreen(), "the stroke drawn under the lock left the screen").toEqual(["during"]);
	});

	it("PIN: a real fork on an unlocked PDF with no save queued still writes its pair and is adopted", async () => {
		const r = rig(serializePage(pdfPage(["a", "b"])));
		await r.ink.ensureLoaded(PDF_ID);
		expect(r.ink.inkReady(PDF_ID), "precondition: a sound open").toBe(true);
		r.adapter.externalWrite(PATH, serializePage(pdfPage(["a"])));

		expect(await r.tick(), "precondition: the pass checked the ink file").toBe(true);

		expect(r.prepare, "the real fork was not prepared").toHaveBeenCalledTimes(1);
		const adoption = await r.adopt.mock.results[0]!.value;
		expect(adoption.outcome, "the real fork was not adopted").toBe("adopted");
		expect(r.pairs().length, "the real fork did not get its pair").toBe(2);
		expect(r.onScreen(), "the record is not the file's revision").toEqual(["a"]);
	});
});
