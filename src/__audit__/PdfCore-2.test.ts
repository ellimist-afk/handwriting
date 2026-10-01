/**
 * AUDIT PROBE PdfCore-2 (read-only audit of 1.4.21, tag 1a05f62c).
 *
 * Claim: a byte-identical copy of a PDF, opened in the same session after the
 * original was opened but never drawn on (so no sidecar on disk), resolves to
 * the ORIGINAL's instance id; claimPath then adds the copy's path to the
 * original's in-memory record, and the first stroke on the copy writes one
 * sidecar that claims both files.
 *
 * Production code driven: HandwritingPlugin.prototype.resolvePdfId (main.ts
 * :1386-1446) on an Object.create instance, the real PageStore (listIds, load,
 * schedule, flush), the real PdfInkStore wired exactly as main.ts:5464-5471
 * wires it, and the real readPdfHead / pdfInkIdFromHead / chooseInstance.
 * The only fakes: an in-memory adapter (FakeAdapter plus a list() that
 * enumerates one folder level, as Obsidian's adapter.list does), the leaf,
 * the pane root and a controller with no-op refresh/refreshStrip.
 *
 * Assertions state the CORRECT behaviour: green = no bug, red = bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(_message: string) {}
	},
}));

import HandwritingPlugin from "../main";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "../pdf/PdfInkStore";
import { parsePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const ORIGINAL = "Template.pdf";
const COPY = "Template 1.pdf";

function stroke(x: number, id: string): InkStroke {
	return {
		id,
		page: 1,
		tool: "pen",
		color: "#111111",
		width: 2,
		createdAt: 0,
		points: [
			{ x, y: 10, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x, y: 10, width: 10, height: 10 },
	};
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function harness() {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	// Obsidian's DataAdapter.list: one level, full vault-relative paths.
	adapter.list = async (folder: string) => {
		const files = [...adapter.files.keys()].filter(
			(p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")
		);
		return { files, folders: [] };
	};
	const store = new PageStore({ vault: { adapter } } as never);
	const pdfStore = new PdfInkStore();
	// Exactly main.ts:5464-5471.
	pdfStore.attachHost({
		load: (id) => store.load(id),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => {},
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing, "pdf"),
		acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
	});
	// Both vault files hold the same bytes: "Make a copy" / a second download.
	const pdfBytes = new TextEncoder().encode(
		"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + "x".repeat(5000) + "\n%%EOF\n"
	);
	const vaultFiles = new Set<string>();
	const app = {
		vault: {
			adapter,
			readBinary: async (_file: { path: string }) => pdfBytes.slice().buffer,
			getFileByPath: (p: string) => (vaultFiles.has(p) ? { path: p } : null),
		},
	};
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, {
		app,
		store,
		pdfStore,
		pdfInk: new Map(),
		pdfIds: new Map(),
		pdfFiles: new Map(),
	});
	const listIds = vi.spyOn(store, "listIds");

	/** syncPdf's mount half for a pane showing `path`, then the real resolvePdfId. */
	async function open(path: string) {
		vaultFiles.add(path);
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, idle: true };
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId({ view: { file: { path } } }, root, controller);
		return { root, id: plugin.pdfIds.get(root) as string };
	}
	/** syncPdf's unmount sweep (main.ts:1364-1370): the pane closes. */
	function close(root: HTMLElement) {
		(root as unknown as { isConnected: boolean }).isConnected = false;
		plugin.pdfInk.delete(root);
		plugin.pdfIds.delete(root);
		plugin.pdfFiles.delete(root);
	}
	/** The controller sink on a committed op: pdfStore.replaceAll(id, next) (main.ts:1278). */
	function draw(id: string, s: InkStroke) {
		pdfStore.replaceAll(id, [...pdfStore.strokes(id), s]);
	}
	function sidecar(id: string) {
		const bytes = adapter.files.get(`.handwriting/${id}.json`);
		return bytes === undefined ? undefined : parsePage(bytes, id).data;
	}
	return { adapter, store, pdfStore, plugin, open, close, draw, sidecar, listIds };
}

describe("PdfCore-2: a copy opened in the same session must start blank", () => {
	it("CONTROL: when the original's sidecar is on disk, the copy gets its own instance", async () => {
		const h = harness();
		const a = await h.open(ORIGINAL);
		h.draw(a.id, stroke(10, "orig-stroke"));
		await h.store.flush();
		expect(h.sidecar(a.id)?.pdfPaths).toEqual([ORIGINAL]);
		h.close(a.root);

		const b = await h.open(COPY);
		// The harness's list() works and the instance logic sees the sidecar.
		expect(b.id).not.toBe(a.id);
		expect(h.pdfStore.strokes(b.id)).toEqual([]);
	});

	it("original opened, never drawn on, pane closed; the byte-identical copy must not share its id or ink", async () => {
		const h = harness();
		const a = await h.open(ORIGINAL);
		// Precondition of the trigger: opening wrote nothing, so there is no
		// sidecar on disk for the original.
		await h.store.flush();
		expect(h.adapter.writes()).toEqual([]);
		expect([...h.adapter.files.keys()].filter((p) => p.startsWith(".handwriting/"))).toEqual([]);
		h.close(a.root);

		const b = await h.open(COPY);
		// Precondition: the copy hashed to the same family (same bytes) and the
		// candidate enumeration found nothing on disk.
		expect(h.listIds).toHaveBeenCalledTimes(2);
		expect(h.listIds.mock.calls[0]![0]).toBe(h.listIds.mock.calls[1]![0]);
		expect(await h.listIds.mock.results[1]!.value).toEqual([]);

		// CORRECT: a copy is its own instance (PdfIdentity.ts:199-201).
		expect.soft(b.id, "copy resolved to the original's instance id").not.toBe(a.id);

		// Draw on the copy and let the write land.
		h.draw(b.id, stroke(50, "copy-stroke"));
		await h.store.flush();

		// CORRECT: the original shows none of the copy's ink ...
		expect.soft(
			h.pdfStore.strokes(a.id).map((s) => s.id),
			"original's live stroke list holds the copy's ink"
		).toEqual([]);
		// ... and the copy's sidecar claims only the copy.
		expect.soft(h.sidecar(b.id)?.pdfPaths, "copy's sidecar claims both files").toEqual([COPY]);
	});
});
