/**
 * Audit #40: one failed read locks a PDF's ink for the session.
 *
 * Today's reopen path retries (PdfInkStore.ensureLoaded). This probes the
 * OTHER half of the fix direction: while the PDF stays open, the production
 * live-reload poll (main.ts, executed via LiveReloadTestHarness) should lift
 * a damage lock once the sidecar reads soundly again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformSync } from "esbuild";
import mainSource from "../main.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { emptyPage, serializePage, type PageData } from "../model/PageData";
import { PdfInkStore } from "../pdf/PdfInkStore";
import { installLiveReloadPoll } from "../testUtils/LiveReloadTestHarness";
import type { InkStroke } from "../ink/Stroke";

const PDF_ID = "pdf-a1b2c3d4";
const PATH = `.handwriting/${PDF_ID}.json`;

// The production host registration, executed from main.ts source (same
// technique as src/persistence/PdfAdoptionRouteEndToEnd.test.ts).
const source = mainSource.replace(/\r\n/g, "\n");
const hostStart = source.indexOf("\t\tthis.pdfStore.attachHost({");
const hostEnd = source.indexOf("\n\t\t});\n", hostStart);
const installPdfPersistenceHost = new Function(
	"Notice",
	"blockNotice",
	transformSync(source.slice(hostStart, hostEnd + "\n\t\t});\n".length), { loader: "ts", target: "es2022" }).code
);

function stroke(id: string): InkStroke {
	return {
		id, page: 1, tool: "pen", color: "#111111", width: 2, createdAt: 0,
		points: [
			{ x: 10, y: 10, pressure: 0.5, t: 0 },
			{ x: 20, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: 10, y: 10, width: 10, height: 10 },
	};
}

function pdfPage(ids: string[]): PageData {
	const page = emptyPage(PDF_ID);
	page.surface = "pdf";
	page.coordSpace = "page-css@1";
	page.pdfPaths = ["Doc.pdf"];
	page.strokes = ids.map(stroke);
	return page;
}

function rig() {
	const adapter = new FakeAdapter();
	// Mid-sync: a truncated sidecar on open.
	adapter.externalWrite(PATH, '{"surface":"pdf","strokes":[');
	const disk = new PageStore({ vault: { adapter } });
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
	return { adapter, disk, ink, controller, async tick() { fire(); await pending; } };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("audit 40: damage lock on a PDF opened mid-sync", () => {
	it("control: reopening (a second ensureLoaded) lifts the lock after a sound read", async () => {
		const r = rig();
		await r.ink.ensureLoaded(PDF_ID);
		expect(r.ink.inkReady(PDF_ID), "precondition: damaged read locks").toBe(false);
		r.adapter.externalWrite(PATH, serializePage(pdfPage(["old"])));
		await r.ink.ensureLoaded(PDF_ID);
		expect(r.ink.inkReady(PDF_ID)).toBe(true);
		expect(r.ink.strokes(PDF_ID).map((s) => s.id)).toEqual(["old"]);
	});

	it("while the PDF stays open, the live-reload poll lifts the lock once the sidecar reads soundly", async () => {
		const r = rig();
		await r.ink.ensureLoaded(PDF_ID);
		expect(r.ink.inkReady(PDF_ID), "precondition: damaged read locks").toBe(false);
		// The sync client finishes writing the sidecar.
		r.adapter.externalWrite(PATH, serializePage(pdfPage(["old"])));
		const stat = vi.spyOn(r.disk, "externallyChanged");
		for (let i = 0; i < 12; i++) {
			vi.advanceTimersByTime(1000);
			await r.tick();
		}
		// Precondition: the poll DID notice the changed sidecar and reached the store.
		const seen = await Promise.all(stat.mock.results.map((x) => x.value));
		expect(seen, "precondition: poll noticed the sidecar change").toContain(true);
		expect(r.ink.strokes(PDF_ID).map((s) => s.id), "ink still hidden while the PDF stays open").toEqual(["old"]);
		expect(r.ink.inkReady(PDF_ID), "still locked: strokes drawn now are never saved").toBe(true);
		expect(r.controller.refresh).toHaveBeenCalled();
	});
});
