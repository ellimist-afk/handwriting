import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformSync } from "esbuild";
import mainSource from "../main.ts?raw";
import {
	PageStore,
	recoverExactPage,
	type ExternalAdoptionPrep,
} from "./PageStore";
import { FakeAdapter, gate } from "./FakeAdapter";
import { isLiveSidecarName } from "./InkFolder";
import { emptyPage, parsePage, serializePage, type PageData } from "../model/PageData";
import { PdfInkStore } from "../pdf/PdfInkStore";
import { installLiveReloadPoll } from "../testUtils/LiveReloadTestHarness";
import type { InkStroke } from "../ink/Stroke";

const PDF_ID = "pdf-a1b2c3d4";
const PATH = `.handwriting/${PDF_ID}.json`;

// Execute the production host object rather than reconstructing its callbacks.
const source = mainSource.replace(/\r\n/g, "\n");
const hostStartMarker = "\t\tthis.pdfStore.attachHost({";
// The registration is one statement; it ends at its own closing line.
const hostEndMarker = "\n\t\t});\n";
expect(source.split(hostStartMarker)).toHaveLength(2);
const hostStart = source.indexOf(hostStartMarker);
const hostEnd = source.indexOf(hostEndMarker, hostStart);
expect(hostStart).toBeGreaterThan(0);
expect(hostEnd).toBeGreaterThan(hostStart);
const hostRegistration = source.slice(hostStart, hostEnd + hostEndMarker.length);
expect(hostRegistration.match(/this\.pdfStore\.attachHost\(/g)).toHaveLength(1);
const installPdfPersistenceHost = new Function(
	"Notice",
	transformSync(hostRegistration, { loader: "ts", target: "es2022" }).code
);

interface PaneRoot { isConnected: boolean }
interface PaneController { idle: boolean; refresh(): void }

function stroke(
	id: string,
	page = 1,
	tool: "pen" | "highlighter" = "pen",
	x = 10
): InkStroke {
	return {
		id,
		tool,
		color: tool === "pen" ? "#4b7bec" : "#f7d154",
		width: tool === "pen" ? 2.23456 : 12.34567,
		createdAt: 2_147_483_648,
		page,
		points: [
			{ x: x + 0.123456, y: 20.234567, pressure: 0.345678, t: 9.876 },
			{ x: x + 30.987654, y: 40.876543, pressure: 0.765432, t: 21.499 },
		],
		bbox: { x: x + 0.123456, y: 20.234567, width: 30.864198, height: 20.641976 },
	};
}

function pdfPage(ids: string[], pdfPaths: string[] = ["Folder/Doc.pdf"]): PageData {
	const page = emptyPage(PDF_ID);
	page.surface = "pdf";
	page.coordSpace = "page-css@1";
	page.pdfPaths = pdfPaths;
	page.textBoxes = [{ id: "tb", x: 12, y: 14, width: 180, z: 2 }];
	page.images = [{ id: "im", x: 20, y: 22, width: 90, height: 70, z: 3 }];
	page.strokes = ids.map((id, i) =>
		stroke(id, i % 2 + 1, i % 2 ? "highlighter" : "pen", 10 + i * 50)
	);
	page.unknownTop = { pdfFuture: { keep: true } };
	page.unknownByObject = {
		tb: { font: "future" },
		im: { crop: [1, 2, 3, 4] },
		...Object.fromEntries(ids.map((id) => [id, { futureStroke: id }])),
	};
	return page;
}

function artifacts(adapter: FakeAdapter): string[] {
	return [...adapter.files.keys()].filter((p) => p.includes(".conflict-external-")).sort();
}

function pair(adapter: FakeAdapter): { outgoing: string; incoming: string } {
	const found = artifacts(adapter);
	const outgoing = found.find((p) => p.endsWith("-outgoing.json"));
	const incoming = found.find((p) => p.endsWith("-incoming.json"));
	if (!outgoing || !incoming) throw new Error(`missing pair: ${found.join(", ")}`);
	return { outgoing, incoming };
}

function attachProductionHost(ink: PdfInkStore, disk: PageStore): void {
	class SilentNotice { constructor(_message: string) {} }
	installPdfPersistenceHost.call({ pdfStore: ink, store: disk }, SilentNotice);
}

function pollBridge(
	ink: PdfInkStore,
	disk: PageStore,
	root: PaneRoot,
	controller: PaneController
): {
	host: { pdfInk: Map<PaneRoot, PaneController>; pdfIds: Map<PaneRoot, string> };
	start(): void;
	settle(): Promise<void>;
	tick(): Promise<void>;
} {
	let fire!: () => void;
	let pending = Promise.resolve();
	const host = {
		store: disk,
		pdfStore: ink,
		pdfInk: new Map<PaneRoot, PaneController>([[root, controller]]),
		pdfIds: new Map<PaneRoot, string>([[root, PDF_ID]]),
		pollStats: { ticks: 0, hidden: 0, spaced: 0, checks: 0 },
		registerInterval: (handle: number) => handle,
	};
	installLiveReloadPoll.call(
		host,
		{ setInterval(fn: () => void) { fire = fn; return 1; } },
		{ hidden: false },
		(work: Promise<void>) => { pending = work.catch(() => {}); },
		() => [],
		{},
		() => {},
		() => {},
		() => null,
		async () => false,
		{ error: () => {} },
		() => null,
	);
	return {
		host,
		start: () => fire(),
		settle: () => pending,
		async tick() { fire(); await pending; },
	};
}

async function settledProductionRig() {
	const adapter = new FakeAdapter();
	adapter.externalWrite(PATH, serializePage(pdfPage(["base", "page-two"])));
	const disk = new PageStore({ vault: { adapter } });
	const ink = new PdfInkStore();
	attachProductionHost(ink, disk);
	await ink.ensureLoaded(PDF_ID);
	ink.commit(PDF_ID, stroke("mine", 2, "pen", 123));
	await disk.flush();
	expect(disk.hasQueuedWrite(PDF_ID)).toBe(false);
	const root = { isConnected: true };
	const controller = { idle: true, refresh: vi.fn() };
	const accept = vi.spyOn(disk, "acceptExternalAdoption");
	return { adapter, disk, ink, root, controller, poll: pollBridge(ink, disk, root, controller), accept };
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let i = 0; i < 100 && !check(); i++) await Promise.resolve();
	expect(check()).toBe(true);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("caller-specific PageStore surface qualification", () => {
	it("prepares PDF only for the explicit PDF caller and keeps inline strict", async () => {
		const adapter = new FakeAdapter();
		adapter.externalWrite(PATH, serializePage(pdfPage(["remote"])));
		const disk = new PageStore({ vault: { adapter } });
		const outgoing = pdfPage(["mine"]);

		const asInline = await disk.prepareExternalAdoption(PDF_ID, outgoing);
		expect(asInline).toMatchObject({ kind: "unavailable", reason: "incoming-unusable" });
		const asPdf = await disk.prepareExternalAdoption(PDF_ID, outgoing, "pdf");
		expect(asPdf.kind).toBe("prepared");
	});

	it("keeps both artifact names outside every live-sidecar namespace", () => {
		expect(isLiveSidecarName(`${PDF_ID}.json`)).toBe(true);
		expect(isLiveSidecarName(`${PDF_ID}.conflict-external-0011223344556677-outgoing.json`)).toBe(false);
		expect(isLiveSidecarName(`${PDF_ID}.conflict-external-0011223344556677-incoming.json`)).toBe(false);
	});
});

describe("production PDF host and poll preserve before adoption", () => {
	it("preserves exact outgoing and incoming revisions, adopts remote order, then saves and reopens", async () => {
		const r = await settledProductionRig();
		// The record loaded the compact codec's decoded base, then received one
		// full-precision session stroke. Compose that exact in-memory shape and
		// detach it before external bytes change and before adoption's first
		// await, so later store or fixture mutation cannot make expected and
		// actual agree by shared reference.
		const loadedBase = parsePage(serializePage(pdfPage(["base", "page-two"])), PDF_ID).data;
		const frozenExpectedOutgoing = structuredClone({
			...loadedBase,
			strokes: [...loadedBase.strokes, stroke("mine", 2, "pen", 123)],
		});
		const incomingPage = pdfPage(["remote-two", "remote-one"], ["Remote/Doc.pdf"]);
		const incomingText = serializePage(incomingPage);
		r.adapter.externalWrite(PATH, incomingText);

		await r.poll.tick();

		expect(r.accept).toHaveBeenCalledTimes(1);
		expect(r.ink.strokes(PDF_ID).map((s) => s.id)).toEqual(["remote-two", "remote-one"]);
		const { outgoing, incoming } = pair(r.adapter);
		expect(r.adapter.files.get(incoming)).toBe(incomingText);
		const recovered = recoverExactPage(parsePage(r.adapter.files.get(outgoing)!, PDF_ID).data);
		expect(recovered).toEqual(frozenExpectedOutgoing);
		expect(recovered.strokes.map((s) => s.id)).toEqual(["base", "page-two", "mine"]);
		expect(recovered.strokes.find((s) => s.id === "mine")!.points[0]!.x).toBe(123.123456);
		expect(recovered.textBoxes).toEqual(pdfPage([]).textBoxes);
		expect(recovered.images).toEqual(pdfPage([]).images);
		expect(recovered.unknownTop.pdfFuture).toEqual({ keep: true });
		expect(recovered.pdfPaths).toEqual(["Folder/Doc.pdf"]);

		const firstArtifacts = artifacts(r.adapter);
		await r.poll.tick();
		expect(r.accept).toHaveBeenCalledTimes(1);
		expect(artifacts(r.adapter)).toEqual(firstArtifacts);

		r.ink.commit(PDF_ID, stroke("after", 1));
		await r.disk.flush();
		expect(parsePage(r.adapter.files.get(PATH)!, PDF_ID).data.strokes.map((s) => s.id)).toEqual([
			"remote-two", "remote-one", "after",
		]);
		const reopened = new PdfInkStore();
		const reopenedDisk = new PageStore({ vault: { adapter: r.adapter } });
		attachProductionHost(reopened, reopenedDisk);
		await reopened.ensureLoaded(PDF_ID);
		expect(reopened.strokes(PDF_ID).map((s) => s.id)).toEqual(["remote-two", "remote-one", "after"]);
		expect(reopened.strokes(PDF_ID).map((s) => s.id)).not.toContain("mine");
	});

	it("uses the source-executed production host callbacks", () => {
		expect(hostRegistration).toContain('this.store.prepareExternalAdoption(id, outgoing, "pdf")');
		expect(hostRegistration).toContain("this.store.acceptExternalAdoption(prepared)");
	});
});

describe("post-await PDF qualification", () => {
	it("holds a true A -> B -> A live mutation even when final content is identical", async () => {
		const adapter = new FakeAdapter();
		adapter.externalWrite(PATH, serializePage(pdfPage(["a"])));
		const disk = new PageStore({ vault: { adapter } });
		const ink = new PdfInkStore();
		const ready = gate();
		const release = gate();
		let accepts = 0;
		ink.attachHost({
			load: (id) => disk.load(id),
			schedule: (id, data) => disk.schedule(id, data),
			notice: () => {},
			prepareExternalAdoption: async (id, outgoing) => {
				const prepared = await disk.prepareExternalAdoption(id, outgoing, "pdf");
				ready.release();
				await release.promise;
				return prepared;
			},
			acceptExternalAdoption: (prepared) => { accepts++; disk.acceptExternalAdoption(prepared); },
		});
		await ink.ensureLoaded(PDF_ID);
		const original = structuredClone(ink.strokes(PDF_ID));
		adapter.externalWrite(PATH, serializePage(pdfPage(["remote"])));
		const running = ink.adoptExternal(PDF_ID, () => true);
		await ready.promise;
		ink.replaceAllLive(PDF_ID, [stroke("b")]);
		ink.replaceAllLive(PDF_ID, original);
		release.release();

		expect(await running).toMatchObject({ outcome: "held", reason: "unsettled" });
		expect(accepts).toBe(0);
		expect(ink.strokes(PDF_ID)).toEqual(original);
		expect(await disk.externallyChanged(PDF_ID)).toBe(true);
	});

	it.each(["idle", "disconnect", "rebind", "replace-controller", "queued-write"] as const)(
		"holds when %s changes during preservation",
		async (change) => {
			const r = await settledProductionRig();
			r.adapter.externalWrite(PATH, serializePage(pdfPage(["remote"])));
			const release = gate();
			r.adapter.writeGate = release.promise;
			const beforeWrites = r.adapter.writeAttempts;
			const adoption = vi.spyOn(r.ink, "adoptExternal");
			r.poll.start();
			await waitFor(() => r.adapter.writeAttempts > beforeWrites);
			if (change === "idle") r.controller.idle = false;
			if (change === "disconnect") r.root.isConnected = false;
			if (change === "rebind") r.poll.host.pdfIds.set(r.root, "pdf-other");
			if (change === "replace-controller") {
				r.poll.host.pdfInk.set(r.root, { idle: true, refresh: vi.fn() });
			}
			if (change === "queued-write") r.ink.commit(PDF_ID, stroke("during"));
			release.release();
			r.adapter.writeGate = null;
			await r.poll.settle();

			const outcome = await adoption.mock.results[0]!.value;
			expect(outcome.outcome).toBe("held");
			expect(r.accept).not.toHaveBeenCalled();
		}
	);

	it("holds when the record is forgotten during preservation", async () => {
		const r = await settledProductionRig();
		r.adapter.externalWrite(PATH, serializePage(pdfPage(["remote"])));
		const release = gate();
		r.adapter.writeGate = release.promise;
		const beforeWrites = r.adapter.writeAttempts;
		const adoption = vi.spyOn(r.ink, "adoptExternal");
		r.poll.start();
		await waitFor(() => r.adapter.writeAttempts > beforeWrites);
		r.ink.forget(PDF_ID);
		release.release();
		r.adapter.writeGate = null;
		await r.poll.settle();
		expect((await adoption.mock.results[0]!.value).outcome).toBe("held");
		expect(r.accept).not.toHaveBeenCalled();
	});

	it("holds when a settled record enters a load while preservation is awaiting", async () => {
		const r = await settledProductionRig();
		const local = structuredClone(r.ink.strokes(PDF_ID));
		r.adapter.externalWrite(PATH, serializePage(pdfPage(["remote"])));
		const preparationReady = gate();
		const releasePreparation = gate();
		const loadStarted = gate();
		const releaseLoad = gate();
		r.ink.attachHost({
			load: async () => {
				loadStarted.release();
				await releaseLoad.promise;
				return null;
			},
			schedule: (id, data) => r.disk.schedule(id, data),
			notice: () => {},
			prepareExternalAdoption: async (id, outgoing) => {
				const prepared = await r.disk.prepareExternalAdoption(id, outgoing, "pdf");
				preparationReady.release();
				await releasePreparation.promise;
				return prepared;
			},
			acceptExternalAdoption: (prepared) => r.disk.acceptExternalAdoption(prepared),
		});

		const adoption = r.ink.adoptExternal(PDF_ID, () => true);
		await preparationReady.promise;
		const reload = r.ink.reloadExternal(PDF_ID);
		await loadStarted.promise;
		releasePreparation.release();
		expect(await adoption).toMatchObject({ outcome: "held", reason: "unsettled" });
		expect(r.accept).not.toHaveBeenCalled();
		releaseLoad.release();
		await reload;
		expect(r.ink.strokes(PDF_ID)).toEqual(local);
		expect(await r.disk.externallyChanged(PDF_ID)).toBe(true);
	});

	it("holds when a settled record becomes locked while preservation is awaiting", async () => {
		const r = await settledProductionRig();
		const local = structuredClone(r.ink.strokes(PDF_ID));
		r.adapter.externalWrite(PATH, serializePage(pdfPage(["remote"])));
		const preparationReady = gate();
		const releasePreparation = gate();
		r.ink.attachHost({
			load: async () => ({
				data: emptyPage(PDF_ID),
				recovered: true,
				damaged: true,
			}),
			schedule: (id, data) => r.disk.schedule(id, data),
			notice: () => {},
			prepareExternalAdoption: async (id, outgoing) => {
				const prepared = await r.disk.prepareExternalAdoption(id, outgoing, "pdf");
				preparationReady.release();
				await releasePreparation.promise;
				return prepared;
			},
			acceptExternalAdoption: (prepared) => r.disk.acceptExternalAdoption(prepared),
		});

		const adoption = r.ink.adoptExternal(PDF_ID, () => true);
		await preparationReady.promise;
		await r.ink.reloadExternal(PDF_ID);
		releasePreparation.release();
		expect(await adoption).toMatchObject({ outcome: "held", reason: "existing-lock" });
		expect(r.accept).not.toHaveBeenCalled();
		expect(r.ink.strokes(PDF_ID)).toEqual(local);
		expect(await r.disk.externallyChanged(PDF_ID)).toBe(true);
	});

	it("holds a candidate superseded while its artifacts are being written", async () => {
		const r = await settledProductionRig();
		r.adapter.externalWrite(PATH, serializePage(pdfPage(["remote-one"])));
		const release = gate();
		r.adapter.writeGate = release.promise;
		const beforeWrites = r.adapter.writeAttempts;
		const running = r.ink.adoptExternal(PDF_ID, () => true);
		await waitFor(() => r.adapter.writeAttempts > beforeWrites);
		r.adapter.externalWrite(PATH, serializePage(pdfPage(["remote-two"])));
		release.release();
		r.adapter.writeGate = null;
		expect(await running).toMatchObject({ outcome: "held", reason: "stale" });
		expect(r.accept).not.toHaveBeenCalled();
		expect(r.ink.strokes(PDF_ID).map((s) => s.id)).toEqual(["base", "page-two", "mine"]);
	});
});

describe("every non-adopted PDF outcome retains replacement authority", () => {
	it("holds while the established record is still loading", async () => {
		const adapter = new FakeAdapter();
		adapter.externalWrite(PATH, serializePage(pdfPage(["mine"])));
		const read = gate();
		adapter.readGate = read.promise;
		const disk = new PageStore({ vault: { adapter } });
		const ink = new PdfInkStore();
		attachProductionHost(ink, disk);
		const loading = ink.ensureLoaded(PDF_ID);
		expect(await ink.adoptExternal(PDF_ID, () => true)).toMatchObject({
			outcome: "held", reason: "unsettled",
		});
		read.release();
		adapter.readGate = null;
		await loading;
	});

	it("holds an established record carrying an unreadable lock", async () => {
		const adapter = new FakeAdapter();
		adapter.externalWrite(PATH, '{"surface":"pdf","strokes":[');
		const disk = new PageStore({ vault: { adapter } });
		const ink = new PdfInkStore();
		attachProductionHost(ink, disk);
		await ink.ensureLoaded(PDF_ID);
		expect(await ink.adoptExternal(PDF_ID, () => true)).toMatchObject({
			outcome: "held", reason: "existing-lock",
		});
	});

	it("holds an established record carrying a future-schema lock", async () => {
		const ink = new PdfInkStore();
		ink.attachHost({
			load: async () => ({ data: pdfPage(["future"]), recovered: false, futureVersion: 99 }),
			schedule: () => {},
			notice: () => {},
			prepareExternalAdoption: async () => {
				throw new Error("locked records must not enter preservation");
			},
			acceptExternalAdoption: () => {},
		});
		await ink.ensureLoaded(PDF_ID);
		expect(await ink.adoptExternal(PDF_ID, () => true)).toMatchObject({
			outcome: "held", reason: "existing-lock",
		});
	});

	it("holds when a lossless immutable snapshot cannot be created", async () => {
		const r = await settledProductionRig();
		vi.stubGlobal("structuredClone", undefined);
		expect(await r.ink.adoptExternal(PDF_ID, () => true)).toEqual({
			outcome: "held", changed: false, reason: "missing-capability",
		});
		expect(r.accept).not.toHaveBeenCalled();
		expect(r.ink.strokes(PDF_ID).map((s) => s.id)).toEqual(["base", "page-two", "mine"]);
	});

	it("holds an established record when preservation capability is missing", async () => {
		const adapter = new FakeAdapter();
		adapter.externalWrite(PATH, serializePage(pdfPage(["mine"])));
		const disk = new PageStore({ vault: { adapter } });
		const ink = new PdfInkStore();
		ink.attachHost({
			load: (id) => disk.load(id),
			schedule: (id, data) => disk.schedule(id, data),
			notice: () => {},
		});
		await ink.ensureLoaded(PDF_ID);
		expect(await ink.adoptExternal(PDF_ID, () => true)).toEqual({
			outcome: "held", changed: false, reason: "missing-capability",
		});
		expect(ink.strokes(PDF_ID).map((s) => s.id)).toEqual(["mine"]);
	});

	it("a preservation write failure holds, leaves the baseline retryable, then succeeds", async () => {
		const r = await settledProductionRig();
		r.adapter.externalWrite(PATH, serializePage(pdfPage(["remote"])));
		r.adapter.failWriteTimes = 1;
		const failed = await r.ink.adoptExternal(PDF_ID, () => true);
		expect(failed).toMatchObject({ outcome: "held", reason: "io-failure" });
		expect(r.accept).not.toHaveBeenCalled();
		expect(r.ink.strokes(PDF_ID).map((s) => s.id)).toEqual(["base", "page-two", "mine"]);
		expect(await r.disk.externallyChanged(PDF_ID)).toBe(true);
		expect((await r.ink.adoptExternal(PDF_ID, () => true)).outcome).toBe("adopted");
	});

	it("a corrupted artifact readback refuses acceptance", async () => {
		class CorruptReadbackAdapter extends FakeAdapter {
			corrupt = false;
			override async read(path: string): Promise<string> {
				const text = await super.read(path);
				return this.corrupt && path.includes(".conflict-external-") ? `${text} ` : text;
			}
		}
		const adapter = new CorruptReadbackAdapter();
		adapter.externalWrite(PATH, serializePage(pdfPage(["mine"])));
		const disk = new PageStore({ vault: { adapter } });
		const ink = new PdfInkStore();
		attachProductionHost(ink, disk);
		await ink.ensureLoaded(PDF_ID);
		adapter.externalWrite(PATH, serializePage(pdfPage(["remote"])));
		adapter.corrupt = true;
		const result = await ink.adoptExternal(PDF_ID, () => true);
		expect(result).toMatchObject({ outcome: "held", reason: "io-failure" });
		expect(ink.strokes(PDF_ID).map((s) => s.id)).toEqual(["mine"]);
	});

	it("a malformed incoming poll holds; a failed guarded save retries and preserves exact evidence", async () => {
		const r = await settledProductionRig();
		const malformed = '{"pageId":"pdf-a1b2c3d4","surface":"pdf","strokes":[';
		r.adapter.externalWrite(PATH, malformed);
		await r.poll.tick();
		expect(r.accept).not.toHaveBeenCalled();
		expect(r.ink.strokes(PDF_ID).map((s) => s.id)).toEqual(["base", "page-two", "mine"]);

		const conflicts: string[] = [];
		r.disk.onConflict = (_id, keptAs) => conflicts.push(keptAs);
		r.ink.commit(PDF_ID, stroke("after-held"));
		r.adapter.failRenameTimes = 1;
		r.adapter.failRenameWhen = (from, to) => from === PATH && to.includes(".conflict-");
		await r.disk.flush();
		expect(r.adapter.files.get(PATH)).toBe(malformed);
		expect(r.disk.hasQueuedWrite(PDF_ID)).toBe(true);
		await r.disk.flush();
		expect(conflicts).toHaveLength(1);
		expect(r.adapter.files.get(conflicts[0]!)).toBe(malformed);
		expect(r.disk.hasQueuedWrite(PDF_ID)).toBe(false);

		const reopened = new PdfInkStore();
		const reopenedDisk = new PageStore({ vault: { adapter: r.adapter } });
		attachProductionHost(reopened, reopenedDisk);
		await reopened.ensureLoaded(PDF_ID);
		expect(reopened.strokes(PDF_ID).map((s) => s.id)).toEqual([
			"base", "page-two", "mine", "after-held",
		]);
	});

	it("never overwrites an occupied artifact name", async () => {
		const realCrypto = globalThis.crypto;
		let call = 0;
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: { getRandomValues: (bytes: Uint8Array) => {
				bytes.fill(call++ === 0 ? 0x11 : 0x22);
				return bytes;
			} },
		});
		try {
			const r = await settledProductionRig();
			const taken = `.handwriting/${PDF_ID}.conflict-external-${"11".repeat(8)}-incoming.json`;
			r.adapter.files.set(taken, "older evidence");
			r.adapter.mtimes.set(taken, ++r.adapter.clock);
			r.adapter.externalWrite(PATH, serializePage(pdfPage(["remote"])));
			const result = await r.ink.adoptExternal(PDF_ID, () => true);
			expect(result.outcome).toBe("adopted");
			expect(r.adapter.files.get(taken)).toBe("older evidence");
			expect(result.outgoingPath).toContain("22".repeat(8));
			expect(result.incomingPath).toContain("22".repeat(8));
		} finally {
			Object.defineProperty(globalThis, "crypto", {
				configurable: true,
				writable: true,
				value: realCrypto,
			});
		}
	});
});
