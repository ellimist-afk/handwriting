/**
 * AUDIT PROBE main-1-1 (read-only audit of 1.4.21, tag 1a05f62c).
 *
 * Claim: resolvePdfId's instance scan calls PageStore.load on every family
 * sidecar, which stamps knownMtime/knownHash with the file on disk, while
 * PdfInkStore.ensureLoaded returns at once for a record that is already
 * loaded (records are never forgotten when a PDF closes). So a PDF reopened
 * after another device wrote its sidecar keeps the old strokes, the poll
 * answers "unchanged", and the next stroke overwrites the other device's ink
 * with no conflict copy.
 *
 * Production code driven: resolvePdfId and the pane sweep sliced verbatim out
 * of main.ts and executed, the real live-reload poll (LiveReloadTestHarness,
 * which slices the same way), PageStore, PdfInkStore with the host wired as
 * main.ts:5464-5471, applyOp as the stroke sink at main.ts:1272-1280.
 *
 * Assertions state the CORRECT behaviour: green = no bug, red = bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformSync } from "esbuild";
import mainSource from "../main.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "../pdf/PdfInkStore";
import { chooseInstance, familyOf, pdfInkIdFromHead } from "../pdf/PdfIdentity";
import { readPdfHead } from "../pdf/PdfHead";
import { applyOp } from "../pdf/PdfInkHistory";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";
import { installLiveReloadPoll } from "../testUtils/LiveReloadTestHarness";

const DEBOUNCE_MS = 700;
const PDF_PATH = "paper.pdf";

// ---- slice production code out of main.ts ---------------------------------
const source = mainSource.replace(/\r\n/g, "\n");

// resolvePdfId, verbatim body.
const resolveStart = "\tprivate async resolvePdfId(\n\t\tleaf: WorkspaceLeaf,\n\t\troot: HTMLElement,\n\t\tcontroller: PdfInkController\n\t): Promise<void> {\n";
const resolveEnd = "\n\t}\n\n\t/**\n\t * Where this PDF's head can be read from";
expect(source.split(resolveStart)).toHaveLength(2);
expect(source.split(resolveEnd)).toHaveLength(2);
const rs = source.indexOf(resolveStart) + resolveStart.length;
const re = source.indexOf(resolveEnd, rs);
const resolveBody = source.slice(rs, re);
expect(resolveBody).toContain("(await this.store.readPdfPaths(cid))");
expect(resolveBody).toContain("await this.pdfStore.ensureLoaded(choice.id);");
const resolvePdfId = new Function(
	"readPdfHead", "pdfInkIdFromHead", "familyOf", "chooseInstance", "window",
	transformSync(
		`return async function resolvePdfId(leaf: any, root: any, controller: any): Promise<void> {\n${resolveBody}\n};`,
		{ loader: "ts", target: "es2022" }
	).code
);

// The pane sweep (main.ts:1364-1370), verbatim.
const sweepStart = "\t\tfor (const [root, controller] of [...this.pdfInk]) {\n\t\t\tif (seen.has(root) && root.isConnected) continue;\n";
expect(source.split(sweepStart)).toHaveLength(2);
const ss = source.indexOf(sweepStart);
const se = source.indexOf("\n\t\t}\n", ss);
const sweepCode = source.slice(ss, se + 4);
expect(sweepCode).toContain("controller.unmount();");
const runSweep = new Function(
	"seen",
	transformSync(sweepCode, { loader: "ts", target: "es2022" }).code
);

// Host wiring precondition: the pdf store's host is exactly this in main.ts.
expect(source).toContain(
	"\t\tthis.pdfStore.attachHost({\n" +
		"\t\t\tload: (id, options) => this.store.load(id, options),\n" +
		"\t\t\tschedule: (id, data) => this.store.schedule(id, data),\n"
);
// Sink precondition: a committed stroke is applyOp + replaceAll.
expect(source).toContain("const next = applyOp(this.pdfStore.strokes(id), op);");
expect(source).toContain("this.pdfStore.replaceAll(id, next);");

// ---- fixtures ---------------------------------------------------------------
function stroke(id: string, x: number): InkStroke {
	return {
		id, page: 1, tool: "pen", color: "#111111", width: 2, createdAt: 0,
		points: [{ x, y: 10, pressure: 0.5, t: 0 }, { x: x + 10, y: 20, pressure: 0.5, t: 8 }],
		bbox: { x, y: 10, width: 10, height: 10 },
	};
}

function sidecar(id: string, strokes: InkStroke[]): string {
	return serializePage({
		...emptyPage(id), surface: "pdf", coordSpace: "page-css@1", pdfPaths: [PDF_PATH], strokes,
	} as never);
}

const PDF_BYTES = new TextEncoder().encode(
	"%PDF-1.4\n% audit probe main-1-1\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n"
);

let fake: FakeAdapter;

async function drain(): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
	for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(0);
}

type Root = { isConnected: boolean };
type Ctl = { idle: boolean; refresh: () => void; refreshStrip: () => void; unmount: () => void };

async function world() {
	(fake as unknown as { list: (f: string) => Promise<{ files: string[]; folders: string[] }> }).list =
		async (folder: string) => ({
			files: [...fake.files.keys()].filter(
				(p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")
			),
			folders: [],
		});
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const pdfStore = new PdfInkStore();
	// As main.ts:5464-5471.
	pdfStore.attachHost({
		load: (id) => store.load(id),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => {},
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing, "pdf"),
		acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
	});
	const host = {
		app: { vault: { getFileByPath: (p: string) => (p === PDF_PATH ? { path: p } : null) } },
		store,
		pdfStore,
		pdfInk: new Map<Root, Ctl>(),
		pdfIds: new Map<Root, string>(),
		pdfFiles: new Map<Root, string>(),
		// The sweep hands a closed pane's id to releasePdfId, which forgets the record once its write lands. This
		// probe is the case where the record stays - another pane still shows the PDF, or it is reopened before the
		// write settles - so the release keeps it; the forget path has its own cell (PdfReopenReload.test.ts).
		releasePdfId: () => {},
		pdfHeadSource: () => ({ whole: async () => PDF_BYTES.slice().buffer }),
		pollStats: { ticks: 0, hidden: 0, spaced: 0, checks: 0 },
		registerInterval: (h: number) => h,
	};
	const resolve = resolvePdfId(readPdfHead, pdfInkIdFromHead, familyOf, chooseInstance, {
		crypto: globalThis.crypto,
	}) as (leaf: unknown, root: Root, controller: Ctl) => Promise<void>;
	const leaf = { view: { file: { path: PDF_PATH } } };

	/** A pdf pane mounting this file: main.ts:1236-1362 in effect. */
	async function open(): Promise<{ root: Root; ctl: Ctl }> {
		const root: Root = { isConnected: true };
		const ctl: Ctl = { idle: true, refresh: vi.fn(), refreshStrip: vi.fn(), unmount: vi.fn() };
		host.pdfFiles.set(root, PDF_PATH);
		host.pdfInk.set(root, ctl);
		await resolve.call(host, leaf, root, ctl);
		return { root, ctl };
	}
	/** The pane closes; the next sync's sweep runs. */
	function close(root: Root): void {
		root.isConnected = false;
		runSweep.call(host, new Set());
	}

	// The real poll.
	let fire!: () => void;
	let pending: Promise<void> = Promise.resolve();
	installLiveReloadPoll.call(
		host,
		{ setInterval(fn: () => void) { fire = fn; return 1; } },
		{ hidden: false },
		(p: Promise<void>) => { pending = p.catch(() => {}); },
		() => [],
		{ pageIdOf: () => null },
		() => {},
		() => {},
		() => null,
		async () => false,
		{ error: () => {} },
		() => () => true
	);
	async function poll(seconds: number): Promise<void> {
		for (let i = 0; i < seconds; i++) {
			await vi.advanceTimersByTimeAsync(1000);
			fire();
			await pending;
			for (let j = 0; j < 20; j++) await vi.advanceTimersByTimeAsync(0);
		}
	}
	/** One committed stroke through the sink main.ts:1272-1280 builds. */
	function draw(id: string, s: InkStroke): void {
		const next = applyOp(pdfStore.strokes(id), { type: "add", strokes: [s], path: id } as never);
		pdfStore.replaceAll(id, next);
	}
	return { store, pdfStore, host, open, close, poll, draw };
}

/** Every copy of stroke `sid` anywhere in the ink folder, live or conflict. */
function filesHolding(sid: string): string[] {
	const out: string[] = [];
	for (const [p, text] of fake.files) {
		if (!p.startsWith(".handwriting/") || !p.endsWith(".json")) continue;
		try {
			const parsed = JSON.parse(text) as { strokes?: { id: string }[] };
			if (parsed.strokes?.some((s) => s.id === sid)) out.push(p);
		} catch {
			/* not a page */
		}
	}
	return out;
}

let ID = "";

beforeEach(async () => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	const head = await readPdfHead({ whole: async () => PDF_BYTES.slice().buffer });
	ID = await pdfInkIdFromHead(head.head, head.byteLength, globalThis.crypto);
	// The session starts with this sidecar on disk: one stroke, A, claimed by paper.pdf.
	fake.files.set(`.handwriting/${ID}.json`, sidecar(ID, [stroke("A", 10)]));
	fake.mtimes.set(`.handwriting/${ID}.json`, ++fake.clock);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("main-1-1: PDF id resolution acknowledges another device's revision", () => {
	it("CONTROL: with the PDF open throughout, the poll adopts the other device's stroke", async () => {
		const w = await world();
		const { root } = await w.open();
		expect(w.host.pdfIds.get(root)).toBe(ID);
		expect(w.pdfStore.strokes(ID).map((s) => s.id)).toEqual(["A"]);
		fake.externalWrite(`.handwriting/${ID}.json`, sidecar(ID, [stroke("A", 10), stroke("B", 50)]));
		await w.poll(6);
		expect(w.pdfStore.strokes(ID).map((s) => s.id)).toEqual(["A", "B"]);
		w.draw(ID, stroke("C", 90));
		await drain();
		const live = parsePage(fake.files.get(`.handwriting/${ID}.json`)!, ID).data.strokes.map((s) => s.id);
		expect(live).toEqual(["A", "B", "C"]);
	});

	it("close, other device writes, reopen, draw: the other device's stroke survives", async () => {
		const w = await world();
		const first = await w.open();
		// PRECONDITION: first open resolved this id and loaded A.
		expect(w.host.pdfIds.get(first.root)).toBe(ID);
		expect(w.pdfStore.strokes(ID).map((s) => s.id)).toEqual(["A"]);

		w.close(first.root);
		// PRECONDITION: the sweep dropped the pane; nothing polls this id now.
		expect(w.host.pdfInk.size).toBe(0);
		expect(w.host.pdfIds.size).toBe(0);
		// PRECONDITION: the session record was kept (no forget anywhere in main.ts).
		expect(source.includes("pdfStore.forget(")).toBe(false);
		expect(w.pdfStore.canPersist(ID)).toBe(true);

		// Sync delivers the iPad's revision: A plus its new stroke B.
		fake.externalWrite(`.handwriting/${ID}.json`, sidecar(ID, [stroke("A", 10), stroke("B", 50)]));
		// PRECONDITION (discriminator): before the reopen's instance scan, the
		// store still sees the iPad's revision as an unacknowledged change.
		expect(await w.store.externallyChanged(ID)).toBe(true);

		const second = await w.open();
		expect(w.host.pdfIds.get(second.root)).toBe(ID);
		const shownAtReopen = w.pdfStore.strokes(ID).map((s) => s.id);
		const polledChange = await w.store.externallyChanged(ID);
		await w.poll(8);
		const shownAfterPoll = w.pdfStore.strokes(ID).map((s) => s.id);

		// The user draws one stroke on the reopened PDF.
		w.draw(ID, stroke("C", 90));
		await drain();
		const live = parsePage(fake.files.get(`.handwriting/${ID}.json`)!, ID).data.strokes.map((s) => s.id);
		const holdingB = filesHolding("B");
		console.log("[main-1-1 close/reopen]", JSON.stringify({
			shownAtReopen, polledChange, shownAfterPoll, live, holdingB,
			files: [...fake.files.keys()],
		}));

		// CORRECT: the other device's stroke reaches the screen once the
		// PDF is open again and the poll has run...
		expect.soft(shownAfterPoll, "B should be shown after reopen + poll").toContain("B");
		// ...and it is never destroyed: it is on disk somewhere after the save.
		expect(holdingB, "stroke B must survive on disk (live or conflict copy)").not.toEqual([]);
	});

	it("second pane opened while the change waits on the poll: the other device's stroke survives", async () => {
		const w = await world();
		const first = await w.open();
		expect(w.pdfStore.strokes(ID).map((s) => s.id)).toEqual(["A"]);
		// Some quiet poll ticks so the stride has backed off (as in real use).
		await w.poll(3);
		expect(w.pdfStore.strokes(ID).map((s) => s.id)).toEqual(["A"]);

		fake.externalWrite(`.handwriting/${ID}.json`, sidecar(ID, [stroke("A", 10), stroke("B", 50)]));
		// A second pane on the same PDF resolves before the next poll check.
		const second = await w.open();
		expect(w.host.pdfIds.get(second.root)).toBe(ID);
		expect(w.host.pdfIds.get(first.root)).toBe(ID);
		await w.poll(8);
		const shownAfterPoll = w.pdfStore.strokes(ID).map((s) => s.id);

		w.draw(ID, stroke("C", 90));
		await drain();
		const live = parsePage(fake.files.get(`.handwriting/${ID}.json`)!, ID).data.strokes.map((s) => s.id);
		const holdingB = filesHolding("B");
		console.log("[main-1-1 second pane]", JSON.stringify({ shownAfterPoll, live, holdingB }));

		expect.soft(shownAfterPoll, "B should be shown after the poll").toContain("B");
		expect(holdingB, "stroke B must survive on disk (live or conflict copy)").not.toEqual([]);
	});
});
