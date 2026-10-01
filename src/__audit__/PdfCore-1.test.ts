/**
 * AUDIT PROBE PdfCore-1 (read-only audit of 1.4.21, tag 1a05f62c), lens EXECUTION.
 *
 * Claim: reopening a PDF runs resolvePdfId, whose instance scan calls
 * PageStore.load on every family sidecar (main.ts:1410-1412). That load
 * re-stamps knownMtime/knownHash from the file now on disk
 * (PageStore.ts:1005-1007), while PdfInkStore.ensureLoaded is a no-op for
 * the record kept from the first open (PdfInkStore.ts:249; nothing in main
 * calls forget). The poll then answers "unchanged" and the next stroke's
 * write sees no external change, so another device's ink is overwritten
 * with no conflict copy.
 *
 * Production code executed: resolvePdfId, pdfHeadSource, the pane sweep and
 * the pdfStore.attachHost wiring, each sliced verbatim out of main.ts; the
 * real live-reload poll (LiveReloadTestHarness slices main.ts the same way);
 * the stroke sink's applyOp + replaceAll; real PageStore, PdfInkStore,
 * PdfIdentity, PdfHead. Stand-ins: an in-memory adapter with list(), and
 * the leaf/root/controller objects.
 *
 * Assertions state the CORRECT behaviour: green = no bug, red = bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformSync } from "esbuild";
import mainSource from "../main.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { emptyPage, parsePage, serializePage, type PageData } from "../model/PageData";
import { PdfInkStore } from "../pdf/PdfInkStore";
import { chooseInstance, familyOf, pdfInkId, pdfInkIdFromHead } from "../pdf/PdfIdentity";
import { readPdfHead } from "../pdf/PdfHead";
import { applyOp } from "../pdf/PdfInkHistory";
import { installLiveReloadPoll } from "../testUtils/LiveReloadTestHarness";
import type { InkStroke } from "../ink/Stroke";

const source = mainSource.replace(/\r\n/g, "\n");

function sliceMethod(startMarker: string): string {
	expect(source.split(startMarker)).toHaveLength(2);
	const start = source.indexOf(startMarker);
	const end = source.indexOf("\n\t}\n", start);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end + 3);
}

// --- production code, sliced verbatim ---------------------------------------
const resolveText = sliceMethod("\tprivate async resolvePdfId(").replace(
	"\tprivate async resolvePdfId(",
	"async function resolvePdfId("
);
expect(resolveText).toContain("(await this.store.readPdfPaths(cid))");
expect(resolveText).toContain("await this.pdfStore.ensureLoaded(choice.id);");
const headText = sliceMethod("\tprivate pdfHeadSource(file: TFile): HeadSource {").replace(
	"\tprivate pdfHeadSource(",
	"function pdfHeadSource("
);
const sliced = new Function(
	"readPdfHead", "pdfInkIdFromHead", "familyOf", "chooseInstance", "window", "Platform", "openRangedFile",
	transformSync(`${resolveText}\n${headText}`, { loader: "ts", target: "es2022" }).code +
		"\nreturn { resolvePdfId, pdfHeadSource };"
);

// attachHost wiring (main.ts:5464-5471).
const hostStartMarker = "\t\tthis.pdfStore.attachHost({";
expect(source.split(hostStartMarker)).toHaveLength(2);
const hostStart = source.indexOf(hostStartMarker);
const hostEnd = source.indexOf("\n\t\t});\n", hostStart) + "\n\t\t});\n".length;
const hostText = source.slice(hostStart, hostEnd);
expect(hostText).toContain("load: (id, options) => this.store.load(id, options),");
const installPdfHost = new Function(
	"Notice",
	transformSync(hostText, { loader: "ts", target: "es2022" }).code
);

// The pane sweep (main.ts:1364-1370).
const sweepStart = "\t\tfor (const [root, controller] of [...this.pdfInk]) {\n\t\t\tif (seen.has(root) && root.isConnected) continue;\n";
expect(source.split(sweepStart)).toHaveLength(2);
const ss = source.indexOf(sweepStart);
const se = source.indexOf("\n\t\t}\n", ss);
const sweepCode = source.slice(ss, se + 4);
expect(sweepCode).toContain("controller.unmount();");
expect(sweepCode).toContain("this.pdfIds.delete(root);");
const runSweep = new Function("seen", transformSync(sweepCode, { loader: "ts", target: "es2022" }).code);

// The committed-stroke sink shape (main.ts:1272-1280).
expect(source).toContain("const next = applyOp(this.pdfStore.strokes(id), op);");
expect(source).toContain("this.pdfStore.replaceAll(id, next);");

// --- fixtures -----------------------------------------------------------------
class ListingAdapter extends FakeAdapter {
	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = path.endsWith("/") ? path : `${path}/`;
		const files: string[] = [];
		let seen = this.dirs.has(path);
		for (const p of this.files.keys()) {
			if (!p.startsWith(prefix)) continue;
			seen = true;
			if (!p.slice(prefix.length).includes("/")) files.push(p);
		}
		if (!seen) throw new Error(`ENOENT ${path}`);
		return { files, folders: [] };
	}
}

const PDF_PATH = "A.pdf";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n% audit probe PdfCore-1\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");

function stroke(id: string, x: number): InkStroke {
	return {
		id, page: 1, tool: "pen", color: "#000000", width: 2, createdAt: 0,
		points: [{ x, y: 20, pressure: 0.5, t: 0 }, { x: x + 20, y: 40, pressure: 0.5, t: 8 }],
		bbox: { x, y: 20, width: 20, height: 20 },
	};
}

function pdfPage(id: string, strokeIds: string[]): PageData {
	const page = emptyPage(id);
	page.surface = "pdf";
	page.coordSpace = "page-css@1";
	page.pdfPaths = [PDF_PATH];
	page.strokes = strokeIds.map((s, i) => stroke(s, 10 + i * 60));
	return page;
}

interface Root { isConnected: boolean }
interface Ctl { idle: boolean; refresh: () => void; refreshStrip: () => void; unmount: () => void }

async function rig() {
	const adapter = new ListingAdapter();
	const ID = await pdfInkId(PDF_BYTES, globalThis.crypto);
	const LIVE = `.handwriting/${ID}.json`;
	adapter.externalWrite(LIVE, serializePage(pdfPage(ID, ["base"])));
	const store = new PageStore({ vault: { adapter } } as never);
	const pdfStore = new PdfInkStore();
	const file = { path: PDF_PATH };
	const leaf = { view: { file } };
	let fire!: () => void;
	let pending: Promise<void> = Promise.resolve();
	const host: Record<string, unknown> & {
		pdfInk: Map<Root, Ctl>;
		pdfIds: Map<Root, string>;
		pdfFiles: Map<Root, string>;
		pollStats: { ticks: number; hidden: number; spaced: number; checks: number };
	} = {
		store,
		pdfStore,
		pdfInk: new Map(),
		pdfIds: new Map(),
		pdfFiles: new Map(),
		// The sweep hands a closed pane's id to releasePdfId, which forgets the record once its write lands. This
		// probe is the case where the record stays - another pane still shows the PDF, or it is reopened before the
		// write settles - so the release keeps it; the forget path has its own cell (PdfReopenReload.test.ts).
		releasePdfId: () => {},
		pollStats: { ticks: 0, hidden: 0, spaced: 0, checks: 0 },
		registerInterval: (h: number) => h,
		app: {
			vault: {
				adapter,
				readBinary: async () => PDF_BYTES.slice().buffer,
				getFileByPath: (p: string) => (p === PDF_PATH ? file : null),
			},
		},
	};
	const fns = sliced(
		readPdfHead, pdfInkIdFromHead, familyOf, chooseInstance, globalThis,
		{ isDesktopApp: false }, undefined
	) as { resolvePdfId: (...a: unknown[]) => Promise<void>; pdfHeadSource: (f: unknown) => unknown };
	host.pdfHeadSource = (f: unknown) => fns.pdfHeadSource.call(host, f);
	class SilentNotice { constructor(_m: string) {} }
	installPdfHost.call(host, SilentNotice);
	installLiveReloadPoll.call(
		host,
		{ setInterval(fn: () => void) { fire = fn; return 1; } },
		{ hidden: false },
		(work: Promise<void>) => { pending = work.catch(() => {}); },
		() => [], { pageIdOf: () => null }, () => {}, () => {}, () => null, async () => false,
		{ error: () => {} }, () => () => true,
	);
	const open = async (): Promise<{ root: Root; ctl: Ctl }> => {
		const root: Root = { isConnected: true };
		const ctl: Ctl = { idle: true, refresh: vi.fn(), refreshStrip: vi.fn(), unmount: vi.fn() };
		host.pdfFiles.set(root, PDF_PATH);
		host.pdfInk.set(root, ctl);
		await fns.resolvePdfId.call(host, leaf, root, ctl);
		return { root, ctl };
	};
	/** The pane closes; the next workspace sync's sweep runs (production code). */
	const close = (root: Root): void => {
		root.isConnected = false;
		runSweep.call(host, new Set());
	};
	/** A committed stroke through the sink main.ts builds. */
	const draw = (s: InkStroke): void => {
		const next = applyOp(pdfStore.strokes(ID), { type: "add", strokes: [s], path: ID } as never);
		pdfStore.replaceAll(ID, next);
	};
	const settleWrites = async (): Promise<void> => {
		await vi.advanceTimersByTimeAsync(1500);
		await store.flush();
		for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
	};
	const ticks = async (n: number): Promise<number> => {
		const before = host.pollStats.checks;
		for (let i = 0; i < n; i++) {
			await vi.advanceTimersByTimeAsync(1100);
			fire();
			await pending;
			for (let j = 0; j < 10; j++) await vi.advanceTimersByTimeAsync(0);
		}
		return host.pollStats.checks - before;
	};
	const liveIds = (): string[] => parsePage(adapter.files.get(LIVE)!, ID).data.strokes.map((s) => s.id);
	const holders = (sid: string): string[] =>
		[...adapter.files.entries()]
			.filter(([p, t]) => p.startsWith(".handwriting/") && t.includes(`"${sid}"`))
			.map(([p]) => p);
	const known = (): number | undefined =>
		(store as unknown as { knownMtime: Map<string, number> }).knownMtime.get(ID);
	return { adapter, ID, LIVE, store, pdfStore, host, open, close, draw, settleWrites, ticks, liveIds, holders, known };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("PdfCore-1: reopening a PDF after another device wrote its sidecar", () => {
	it("precondition: main.ts never forgets a PdfInkStore record or calls reloadExternal", () => {
		expect(source).not.toMatch(/pdfStore\.forget\(/);
		expect(source).not.toMatch(/pdfStore\.reloadExternal\(/);
	});

	it("control 1: a pane left open adopts the iPad revision through the poll, and the next stroke keeps it", async () => {
		const r = await rig();
		await r.open();
		r.draw(stroke("desk1", 200));
		await r.settleWrites();
		expect(r.liveIds()).toEqual(["base", "desk1"]);
		r.adapter.externalWrite(r.LIVE, serializePage(pdfPage(r.ID, ["base", "desk1", "ipad1"])));
		expect(await r.ticks(10)).toBeGreaterThan(0);
		expect(r.pdfStore.strokes(r.ID).map((s) => s.id)).toContain("ipad1");
		r.draw(stroke("desk2", 300));
		await r.settleWrites();
		expect(r.liveIds()).toEqual(expect.arrayContaining(["ipad1", "desk2"]));
	});

	it("control 2 (write guard): with the baseline NOT re-stamped, a stale-record write preserves the iPad revision", async () => {
		const r = await rig();
		const first = await r.open();
		r.draw(stroke("desk1", 200));
		await r.settleWrites();
		r.close(first.root);
		r.adapter.externalWrite(r.LIVE, serializePage(pdfPage(r.ID, ["base", "desk1", "ipad1"])));
		// No reopen: write straight from the kept (stale) record.
		r.draw(stroke("desk2", 300));
		await r.settleWrites();
		expect(r.liveIds()).toContain("desk2");
		expect(r.holders("ipad1").length, `files: ${JSON.stringify([...r.adapter.files.keys()])}`).toBeGreaterThan(0);
	});

	it("close, iPad sidecar syncs in, reopen, draw: iPad ink shown and never destroyed", async () => {
		const r = await rig();
		const first = await r.open();
		expect(r.host.pdfIds.get(first.root)).toBe(r.ID);
		expect(r.pdfStore.strokes(r.ID).map((s) => s.id)).toEqual(["base"]);
		r.draw(stroke("desk1", 200));
		await r.settleWrites();
		expect(r.liveIds()).toEqual(["base", "desk1"]);

		r.close(first.root);
		// PRECONDITION: the production sweep dropped the pane, the record stays.
		expect(r.host.pdfInk.size).toBe(0);
		expect(r.host.pdfIds.size).toBe(0);
		expect(r.pdfStore.canPersist(r.ID)).toBe(true);

		// iPad revision lands while A.pdf is closed.
		r.adapter.externalWrite(r.LIVE, serializePage(pdfPage(r.ID, ["base", "desk1", "ipad1"])));
		const ipadMtime = r.adapter.mtimes.get(r.LIVE)!;
		const knownBeforeReopen = r.known();
		expect(knownBeforeReopen).not.toBe(ipadMtime);

		const second = await r.open();
		// PRECONDITION: reopen resolved the same id; the pane is poll-eligible.
		expect(r.host.pdfIds.get(second.root)).toBe(r.ID);
		expect(r.host.pdfInk.get(second.root)).toBe(second.ctl);
		const knownAfterReopen = r.known();
		const shownAtReopen = r.pdfStore.strokes(r.ID).map((s) => s.id);

		await vi.advanceTimersByTimeAsync(6000);
		const checks = await r.ticks(10);
		expect(checks, "the poll really checked this id").toBeGreaterThan(0);
		const shownAfterPoll = r.pdfStore.strokes(r.ID).map((s) => s.id);

		r.draw(stroke("desk2", 300));
		await r.settleWrites();
		// PRECONDITION: the stroke reached disk.
		expect(r.liveIds()).toContain("desk2");
		const holders = r.holders("ipad1");
		console.log("[PdfCore-1]", JSON.stringify({
			knownBeforeReopen, ipadMtime, knownAfterReopen, shownAtReopen, shownAfterPoll,
			live: r.liveIds(), holders, files: [...r.adapter.files.keys()], log: r.adapter.log,
		}));

		// CORRECT: the iPad ink reaches the screen after reopen + poll...
		expect.soft(shownAfterPoll, "ipad1 shown after reopen + poll").toContain("ipad1");
		// ...and it survives the next desktop stroke, live or as a conflict copy.
		expect(holders, "ipad1 must survive on disk (live file or conflict copy)").not.toEqual([]);
	});
});
