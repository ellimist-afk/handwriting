/**
 * AUDIT PROBE L-persist-2 (read-only audit of 1.4.21, tag 1a05f62c).
 *
 * Claim: reopening a PDF in the same session runs resolvePdfId, whose
 * `this.store.load(cid)` (main.ts:1411) re-stamps PageStore's knownMtime /
 * knownHash from the sidecar on disk, while `pdfStore.ensureLoaded` (main.ts:
 * 1422) is a no-op for the record kept from the first open. The poll then
 * reports "unchanged" and the next stroke overwrites the other device's ink
 * with no conflict copy.
 *
 * Production code driven: PageStore, PdfInkStore, the PDF host object sliced
 * from main.ts (attachHost), resolvePdfId and pdfHeadSource sliced from
 * main.ts, the real live-reload poll (LiveReloadTestHarness), real
 * PdfIdentity/PdfHead. The only stand-ins: an in-memory adapter (FakeAdapter
 * plus list()), the leaf/root/controller objects, and the pane sweep's three
 * map deletes (main.ts:1364-1369) done by hand.
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

// Production host object (main.ts:5621-5628), executed rather than rebuilt.
// The slice ends at the object's own closing line, not at whatever
// statement follows it: the settings rewrite moved the next line.
const hostStartMarker = "\t\tthis.pdfStore.attachHost({";
const hostEndMarker = "\n\t\t});";
expect(source.split(hostStartMarker)).toHaveLength(2);
const hostStart = source.indexOf(hostStartMarker);
const hostEnd = source.indexOf(hostEndMarker, hostStart) + hostEndMarker.length;
const installPdfPersistenceHost = new Function(
	"Notice",
	transformSync(source.slice(hostStart, hostEnd), { loader: "ts", target: "es2022" }).code
);

// Production resolvePdfId (main.ts:1382-1446) and pdfHeadSource (:1467).
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

/** FakeAdapter has no list(); the real vault adapter does, and listIds needs it. */
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

const PDF_PATH = "lecture.pdf";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n% lecture notes, audit probe L-persist-2\n%%EOF\n");

function stroke(id: string, x = 10): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		createdAt: 0,
		page: 1,
		points: [
			{ x, y: 20, pressure: 0.5, t: 0 },
			{ x: x + 30, y: 40, pressure: 0.5, t: 8 },
		],
		bbox: { x, y: 20, width: 30, height: 20 },
	};
}

function pdfPage(id: string, ids: string[]): PageData {
	const page = emptyPage(id);
	page.surface = "pdf";
	page.coordSpace = "page-css@1";
	page.pdfPaths = [PDF_PATH];
	page.strokes = ids.map((s, i) => stroke(s, 10 + i * 50));
	return page;
}

interface Root { isConnected: boolean }
interface Ctl { idle: boolean; refresh: () => void; refreshStrip: () => void }

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
	installPdfPersistenceHost.call(host, SilentNotice);
	installLiveReloadPoll.call(
		host,
		{ setInterval(fn: () => void) { fire = fn; return 1; } },
		{ hidden: false },
		(work: Promise<void>) => { pending = work.catch(() => {}); },
		() => [], {}, () => {}, () => {}, () => null, async () => false, { error: () => {} }, () => null,
	);
	/** Open the PDF in a pane: controller mounted, then the production resolve. */
	const open = async (): Promise<{ root: Root; ctl: Ctl }> => {
		const root = { isConnected: true };
		const ctl = { idle: true, refresh: vi.fn(), refreshStrip: vi.fn() };
		host.pdfFiles.set(root, PDF_PATH);
		host.pdfInk.set(root, ctl);
		await fns.resolvePdfId.call(host, leaf, root, ctl);
		return { root, ctl };
	};
	/** The pane sweep at main.ts:1364-1369: unmount, drop the three maps. */
	const close = (root: Root): void => {
		root.isConnected = false;
		host.pdfInk.delete(root);
		host.pdfIds.delete(root);
		host.pdfFiles.delete(root);
	};
	const ticks = async (n: number): Promise<number> => {
		const before = host.pollStats.checks;
		for (let i = 0; i < n; i++) {
			await vi.advanceTimersByTimeAsync(1100);
			fire();
			await pending;
		}
		return host.pollStats.checks - before;
	};
	const liveIds = (): string[] => parsePage(adapter.files.get(LIVE)!, ID).data.strokes.map((s) => s.id);
	return { adapter, ID, LIVE, store, pdfStore, host, open, close, ticks, liveIds };
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** Desktop: open, draw, close. Tablet's revision syncs in. Desktop reopens. */
async function scenario(): Promise<Rig & { knownAfterReopen: number | undefined; tabletMtime: number }> {
	const r = await rig();
	const first = await r.open();
	expect(r.host.pdfIds.get(first.root)).toBe(r.ID);
	expect(r.pdfStore.strokes(r.ID).map((s) => s.id)).toEqual(["base"]);
	r.pdfStore.commit(r.ID, stroke("desk1", 200));
	await r.store.flush();
	expect(r.liveIds()).toEqual(["base", "desk1"]);
	r.close(first.root);

	// Tablet adds ink to the same PDF; the sidecar syncs in while closed.
	r.adapter.externalWrite(r.LIVE, serializePage(pdfPage(r.ID, ["base", "desk1", "tablet1"])));
	const tabletMtime = r.adapter.mtimes.get(r.LIVE)!;
	expect(r.adapter.files.get(r.LIVE)!).toContain('"tablet1"'); // the holder search below can see it

	// Same desktop session: reopen lecture.pdf.
	const second = await r.open();
	expect(r.host.pdfIds.get(second.root)).toBe(r.ID);
	const knownAfterReopen = (r.store as unknown as { knownMtime: Map<string, number> }).knownMtime.get(r.ID);
	return { ...r, knownAfterReopen, tabletMtime };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("L-persist-2: reopening a PDF in the same session", () => {
	it("precondition: nothing in main.ts ever forgets a PdfInkStore record", () => {
		expect(source).not.toMatch(/pdfStore\.forget\(/);
		expect(source).not.toMatch(/pdfStore\.reloadExternal\(/);
	});

	it("control A: a pane kept open adopts the tablet's revision through the poll", async () => {
		const r = await rig();
		await r.open();
		r.pdfStore.commit(r.ID, stroke("desk1", 200));
		await r.store.flush();
		r.adapter.externalWrite(r.LIVE, serializePage(pdfPage(r.ID, ["base", "desk1", "tablet1"])));
		expect(await r.ticks(8)).toBeGreaterThan(0);
		expect(r.pdfStore.strokes(r.ID).map((s) => s.id)).toContain("tablet1");
	});

	it("control B: a fresh session reopening the PDF reads the tablet's revision", async () => {
		const r = await rig();
		await r.open();
		r.pdfStore.commit(r.ID, stroke("desk1", 200));
		await r.store.flush();
		r.adapter.externalWrite(r.LIVE, serializePage(pdfPage(r.ID, ["base", "desk1", "tablet1"])));
		const r2 = await rig();
		for (const [p, t] of r.adapter.files) r2.adapter.externalWrite(p, t);
		await r2.open();
		expect(r2.pdfStore.strokes(r2.ID).map((s) => s.id)).toContain("tablet1");
	});

	it("reopened in the same session, the tablet's ink appears (poll or load)", async () => {
		const r = await scenario();
		// MECHANISM PRECONDITION: the reopen's instance read left the change
		// baseline where the record's own last write put it, not on the
		// tablet's revision it never loaded (it used to move it there).
		expect(r.knownAfterReopen).not.toBe(r.tabletMtime);
		await vi.advanceTimersByTimeAsync(6000); // past the 5 s same-mtime content-check window
		const checks = await r.ticks(10);
		expect(checks).toBeGreaterThan(0); // the poll really ran checks for this id
		expect(
			r.pdfStore.strokes(r.ID).map((s) => s.id),
			"desktop record after reopen + 10 poll ticks"
		).toContain("tablet1");
	});

	it("the next desktop stroke does not destroy the tablet's ink (live file or conflict copy)", async () => {
		const r = await scenario();
		expect(r.knownAfterReopen).not.toBe(r.tabletMtime);
		await vi.advanceTimersByTimeAsync(6000);
		await r.ticks(10);
		r.pdfStore.commit(r.ID, stroke("desk2", 300));
		await r.store.flush();
		await vi.advanceTimersByTimeAsync(2000);
		// The write landed (precondition: the stroke did reach disk).
		expect(r.liveIds()).toContain("desk2");
		const holders = [...r.adapter.files.entries()]
			.filter(([, t]) => t.includes('"tablet1"'))
			.map(([p]) => p);
		expect(
			holders.length,
			`files holding tablet1: ${JSON.stringify(holders)}; all files: ${JSON.stringify([...r.adapter.files.keys()])}; live strokes: ${JSON.stringify(r.liveIds())}`
		).toBeGreaterThan(0);
	});
});
