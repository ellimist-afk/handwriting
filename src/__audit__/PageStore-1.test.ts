/**
 * AUDIT PROBE PageStore-1 (read-only audit of 1.4.21, tag 1a05f62c).
 *
 * Claim: resolvePdfId (main.ts:1410-1411) calls PageStore.load on every
 * family sidecar just to read pdfPaths. load stamps knownMtime/knownHash with
 * the file on disk (PageStore.ts:1005-1007). The PdfInkStore record from an
 * earlier open in the same session is never forgotten, so ensureLoaded
 * returns early (PdfInkStore.ts:249). The screen keeps the old ink, the poll
 * answers "unchanged", and the next stroke replaces the other device's
 * sidecar with no conflict copy.
 *
 * Production code driven: PageStore, PdfInkStore (host wired as
 * main.ts:5464-5471), applyOp as the stroke sink (main.ts:1272-1280),
 * resolvePdfId and the pane sweep (main.ts:1364-1370) sliced verbatim out of
 * main.ts and executed, and the real live-reload poll (LiveReloadTestHarness,
 * which slices main.ts the same way).
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
const PDF_PATH = "lecture.pdf";

// ---- production code sliced out of main.ts ---------------------------------
const source = mainSource.replace(/\r\n/g, "\n");

const resolveStart =
	"\tprivate async resolvePdfId(\n\t\tleaf: WorkspaceLeaf,\n\t\troot: HTMLElement,\n\t\tcontroller: PdfInkController\n\t): Promise<void> {\n";
const resolveEnd = "\n\t}\n\n\t/**\n\t * Where this PDF's head can be read from";
expect(source.split(resolveStart)).toHaveLength(2);
expect(source.split(resolveEnd)).toHaveLength(2);
const rStart = source.indexOf(resolveStart) + resolveStart.length;
const rEnd = source.indexOf(resolveEnd, rStart);
const resolveBody = source.slice(rStart, rEnd);
// The cited lines are in the slice being executed.
expect(resolveBody).toContain("(await this.store.readPdfPaths(cid))");
expect(resolveBody).toContain("await this.pdfStore.ensureLoaded(choice.id);");
expect(resolveBody).toContain("this.pdfStore.claimPath(choice.id, path);");
const makeResolve = new Function(
	"readPdfHead", "pdfInkIdFromHead", "familyOf", "chooseInstance", "window",
	transformSync(
		`return async function resolvePdfId(leaf: any, root: any, controller: any): Promise<void> {\n${resolveBody}\n};`,
		{ loader: "ts", target: "es2022" }
	).code
);

// Pane sweep: what runs when a PDF tab closes or switches file.
const sweepStart =
	"\t\tfor (const [root, controller] of [...this.pdfInk]) {\n\t\t\tif (seen.has(root) && root.isConnected) continue;\n";
expect(source.split(sweepStart)).toHaveLength(2);
const sStart = source.indexOf(sweepStart);
const sEnd = source.indexOf("\n\t\t}\n", sStart);
const sweepCode = source.slice(sStart, sEnd + 4);
expect(sweepCode).toContain("controller.unmount();");
const runSweep = new Function("seen", transformSync(sweepCode, { loader: "ts", target: "es2022" }).code);

// Wiring preconditions.
expect(source).toContain(
	"\t\tthis.pdfStore.attachHost({\n" +
		"\t\t\tload: (id, options) => this.store.load(id, options),\n" +
		"\t\t\tschedule: (id, data) => this.store.schedule(id, data),\n"
);
expect(source).toContain("const next = applyOp(this.pdfStore.strokes(id), op);");
expect(source).toContain("this.pdfStore.replaceAll(id, next);");

// ---- fixtures -------------------------------------------------------------
function stroke(id: string, x: number): InkStroke {
	return {
		id, page: 1, tool: "pen", color: "#000000", width: 2, createdAt: 0,
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
	"%PDF-1.4\n% audit probe PageStore-1\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n"
);

let fake: FakeAdapter;
let ID = "";
const LIVE = () => `.handwriting/${ID}.json`;

async function drain(): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
	for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(0);
}

type Root = { isConnected: boolean };
type Ctl = { idle: boolean; refresh: () => void; refreshStrip: () => void; unmount: () => void };

function liveIds(): string[] {
	return parsePage(fake.files.get(LIVE())!, ID).data.strokes.map((s) => s.id);
}

/** Every file in the ink folder (live or conflict copy) holding stroke `sid`. */
function filesHolding(sid: string): string[] {
	const out: string[] = [];
	for (const [p, text] of fake.files) {
		if (!p.startsWith(".handwriting/")) continue;
		try {
			const parsed = JSON.parse(text) as { strokes?: { id: string }[] };
			if (parsed.strokes?.some((s) => s.id === sid)) out.push(p);
		} catch {
			/* not a page */
		}
	}
	return out;
}

function desktop() {
	(fake as unknown as { list: (f: string) => Promise<{ files: string[]; folders: string[] }> }).list =
		async (folder: string) => ({
			files: [...fake.files.keys()].filter(
				(p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")
			),
			folders: [],
		});
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const pdfStore = new PdfInkStore();
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
	const resolve = makeResolve(readPdfHead, pdfInkIdFromHead, familyOf, chooseInstance, {
		crypto: globalThis.crypto,
	}) as (leaf: unknown, root: Root, controller: Ctl) => Promise<void>;
	const leaf = { view: { file: { path: PDF_PATH } } };

	async function open(): Promise<Root> {
		const root: Root = { isConnected: true };
		const ctl: Ctl = { idle: true, refresh: vi.fn(), refreshStrip: vi.fn(), unmount: vi.fn() };
		host.pdfFiles.set(root, PDF_PATH);
		host.pdfInk.set(root, ctl);
		await resolve.call(host, leaf, root, ctl);
		return root;
	}
	function close(root: Root): void {
		root.isConnected = false;
		runSweep.call(host, new Set());
	}

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
	function draw(s: InkStroke): void {
		const next = applyOp(pdfStore.strokes(ID), { type: "add", strokes: [s], path: ID } as never);
		pdfStore.replaceAll(ID, next);
	}
	return { store, pdfStore, host, open, close, poll, draw };
}

beforeEach(async () => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	const head = await readPdfHead({ whole: async () => PDF_BYTES.slice().buffer });
	ID = await pdfInkIdFromHead(head.head, head.byteLength, globalThis.crypto);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("PageStore-1: reopening a PDF must not acknowledge an unread revision", () => {
	it("CONTROL: PDF left open, iPad writes, poll adopts, desktop stroke keeps the iPad's ink", async () => {
		fake.files.set(LIVE(), sidecar(ID, [stroke("A", 10)]));
		fake.mtimes.set(LIVE(), ++fake.clock);
		const d = desktop();
		await d.open();
		expect(d.pdfStore.strokes(ID).map((s) => s.id)).toEqual(["A"]);
		fake.externalWrite(LIVE(), sidecar(ID, [stroke("A", 10), stroke("B", 50)]));
		await d.poll(8);
		expect(d.pdfStore.strokes(ID).map((s) => s.id)).toEqual(["A", "B"]);
		d.draw(stroke("C", 90));
		await drain();
		expect(liveIds()).toEqual(["A", "B", "C"]);
	});

	it("finding trigger: open, draw, close; iPad adds ink; reopen, draw one stroke", async () => {
		fake.files.set(LIVE(), sidecar(ID, [stroke("A", 10)]));
		fake.mtimes.set(LIVE(), ++fake.clock);
		const d = desktop();

		// Desktop opens X and draws D; it is saved.
		const first = await d.open();
		expect(d.host.pdfIds.get(first)).toBe(ID);
		d.draw(stroke("D", 30));
		await drain();
		expect(liveIds()).toEqual(["A", "D"]);

		// Desktop closes the tab. PRECONDITION: pane maps cleared, record kept.
		d.close(first);
		expect(d.host.pdfInk.size).toBe(0);
		expect(d.host.pdfIds.size).toBe(0);
		expect(source.includes("pdfStore.forget(")).toBe(false);
		expect(d.pdfStore.strokes(ID).map((s) => s.id)).toEqual(["A", "D"]);

		// iPad annotates; sync delivers its sidecar (A, D, B).
		fake.externalWrite(LIVE(), sidecar(ID, [stroke("A", 10), stroke("D", 30), stroke("B", 50)]));
		const ipadMtime = fake.mtimes.get(LIVE())!;
		// PRECONDITION: before reopen the store's baseline is still the desktop's own write.
		const knownBefore = (d.store as unknown as { knownMtime: Map<string, number> }).knownMtime.get(ID);
		expect(knownBefore).not.toBe(ipadMtime);

		// Desktop reopens X in the same session.
		const second = await d.open();
		expect(d.host.pdfIds.get(second)).toBe(ID);
		const knownAfter = (d.store as unknown as { knownMtime: Map<string, number> }).knownMtime.get(ID);
		const shownAtReopen = d.pdfStore.strokes(ID).map((s) => s.id);
		await d.poll(8);
		const shownAfterPoll = d.pdfStore.strokes(ID).map((s) => s.id);

		// One stroke.
		d.draw(stroke("C", 90));
		await drain();
		const live = liveIds();
		const holdingB = filesHolding("B");
		const conflictCopies = [...fake.files.keys()].filter((p) => p.includes("conflict"));
		console.log("[PageStore-1 trigger]", JSON.stringify({
			ipadMtime, knownBefore, knownAfter, shownAtReopen, shownAfterPoll, live, holdingB, conflictCopies,
			files: [...fake.files.keys()],
		}));

		expect.soft(shownAfterPoll, "iPad stroke B shown after reopen + poll").toContain("B");
		// CORRECT: the iPad's stroke is never destroyed by the desktop's save.
		expect(holdingB, "stroke B must survive on disk (live or conflict copy)").not.toEqual([]);
	});

	it("DISCRIMINATOR: same stale record, no reopen scan: the write guard keeps B as a conflict copy", async () => {
		// Same state as the trigger, but the stroke lands without resolvePdfId's
		// load() having moved the baseline. If B survives here, the reopen scan's
		// restamp is the step that loses it.
		fake.files.set(LIVE(), sidecar(ID, [stroke("A", 10)]));
		fake.mtimes.set(LIVE(), ++fake.clock);
		const d = desktop();
		const first = await d.open();
		d.draw(stroke("D", 30));
		await drain();
		d.close(first);
		fake.externalWrite(LIVE(), sidecar(ID, [stroke("A", 10), stroke("D", 30), stroke("B", 50)]));
		d.draw(stroke("C", 90));
		await drain();
		const holdingB = filesHolding("B");
		console.log("[PageStore-1 discriminator]", JSON.stringify({ live: liveIds(), holdingB, files: [...fake.files.keys()] }));
		expect(holdingB).not.toEqual([]);
	});

	it("wider: desktop never drew, PDF opened once, iPad writes the first ink, reopen, draw", async () => {
		// No sidecar at session start.
		const d = desktop();
		const first = await d.open();
		expect(d.host.pdfIds.get(first)).toBe(ID);
		expect(fake.files.has(LIVE())).toBe(false);
		d.close(first);

		fake.externalWrite(LIVE(), sidecar(ID, [stroke("B", 50)]));
		const second = await d.open();
		expect(d.host.pdfIds.get(second)).toBe(ID);
		await d.poll(8);
		const shownAfterPoll = d.pdfStore.strokes(ID).map((s) => s.id);
		d.draw(stroke("C", 90));
		await drain();
		const holdingB = filesHolding("B");
		console.log("[PageStore-1 never-drew]", JSON.stringify({
			shownAfterPoll, live: liveIds(), holdingB, files: [...fake.files.keys()],
		}));
		expect.soft(shownAfterPoll, "iPad stroke B shown after reopen + poll").toContain("B");
		expect(holdingB, "stroke B must survive on disk (live or conflict copy)").not.toEqual([]);
	});
});
