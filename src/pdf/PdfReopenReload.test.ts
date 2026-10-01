/**
 * Closing the last pane on a PDF forgets its session record once the ink is on
 * disk, so reopening it reads the sidecar as it is then.
 *
 * The case this guards: a PDF is drawn on and closed, another device adds ink
 * and its sidecar syncs in, and the PDF is reopened in the same session. A
 * record kept from before the close showed none of the other device's ink, and
 * its next save either wrote over that ink or, with the write guard, set it
 * aside as a conflict copy. Forgotten, the reopen loads the synced sidecar: the
 * other ink is on screen and the next stroke is saved beside it.
 *
 * Production code driven: HandwritingPlugin.prototype.syncPdfControllers (its
 * sweep and releasePdfId) and resolvePdfId on an Object.create instance, over
 * the real PageStore and PdfInkStore wired as main.ts wires them. Fakes: an
 * in-memory adapter with a one-level list(), the leaves and the controllers.
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
import { PdfInkStore } from "./PdfInkStore";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const PDF = "Lecture.pdf";

function stroke(id: string, x: number): InkStroke {
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
	adapter.list = async (folder: string) => {
		const files = [...adapter.files.keys()].filter(
			(p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")
		);
		return { files, folders: [] };
	};
	const store = new PageStore({ vault: { adapter } } as never);
	const pdfStore = new PdfInkStore();
	pdfStore.attachHost({
		load: (id) => store.load(id),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => {},
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing, "pdf"),
		acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
	});
	const pdfBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + "y".repeat(4000) + "\n%%EOF\n");
	const leaves: { view: { containerEl: HTMLElement; file: { path: string } } }[] = [];
	const app = {
		vault: {
			adapter,
			readBinary: async () => pdfBytes.slice().buffer,
			getFileByPath: (p: string) => (p === PDF ? { path: p } : null),
		},
		workspace: { getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []) },
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, { app, store, pdfStore, pdfInk: new Map(), pdfIds: new Map(), pdfFiles: new Map() });

	/** A pane showing the PDF: the controller mount() would have built, then the real resolvePdfId. */
	async function open() {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, unmount() {}, forgetHistory() {}, idle: true };
		leaves.push({ view: { containerEl: root, file: { path: PDF } } });
		plugin.pdfFiles.set(root, PDF);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId({ view: { file: { path: PDF } } }, root, controller);
		return { root, id: plugin.pdfIds.get(root) as string };
	}
	/** The pane closes: its leaf is gone and the next workspace sync runs the real sweep. */
	function close(root: HTMLElement) {
		leaves.splice(leaves.findIndex((l) => l.view.containerEl === root), 1);
		(root as unknown as { isConnected: boolean }).isConnected = false;
		plugin.syncPdfControllers();
	}
	const live = (id: string) => `.handwriting/${id}.json`;
	const liveIds = (id: string) => parsePage(adapter.files.get(live(id))!, id).data.strokes.map((s) => s.id);
	const inkFiles = () => [...adapter.files.keys()].filter((p) => p.startsWith(".handwriting/"));
	return { adapter, store, pdfStore, plugin, open, close, live, liveIds, inkFiles };
}

describe("closing the last pane on a PDF forgets its record once saved; reopening reads the disk", () => {
	it("close, another device's ink syncs in, reopen: that ink shows, the next stroke keeps it, no conflict copy", async () => {
		const h = harness();
		const a = await h.open();
		h.pdfStore.replaceAll(a.id, [stroke("desk1", 10)]);
		h.close(a.root);
		// The release waits for the write, then forgets the record.
		await vi.waitFor(() => expect(h.pdfStore.generation(a.id), "record forgotten after its write landed").toBeNull());
		expect(h.liveIds(a.id), "precondition: the desk stroke reached disk before the forget").toEqual(["desk1"]);

		// Another device adds ink; its sidecar syncs in while the PDF is closed.
		const synced = emptyPage(a.id);
		synced.surface = "pdf";
		synced.coordSpace = "page-css@1";
		synced.pdfPaths = [PDF];
		synced.strokes = [stroke("desk1", 10), stroke("tablet1", 60)];
		h.adapter.externalWrite(h.live(a.id), serializePage(synced));

		const b = await h.open();
		expect(b.id, "precondition: the reopen resolves to the same instance").toBe(a.id);
		expect(h.pdfStore.strokes(b.id).map((s) => s.id), "the other device's ink is on screen").toEqual(["desk1", "tablet1"]);

		h.pdfStore.replaceAll(b.id, [...h.pdfStore.strokes(b.id), stroke("desk2", 110)]);
		await h.store.flush();
		expect(h.liveIds(b.id), "the next stroke is saved beside it").toEqual(["desk1", "tablet1", "desk2"]);
		expect(h.inkFiles(), "no conflict copy: nothing was written over").toEqual([h.live(b.id)]);
	});

	it("a second pane still showing the PDF keeps the record", async () => {
		const h = harness();
		const a = await h.open();
		const b = await h.open();
		expect(b.id).toBe(a.id);
		h.pdfStore.replaceAll(a.id, [stroke("desk1", 10)]);
		h.close(a.root);
		await h.store.flush();
		await new Promise((r) => setTimeout(r, 0));
		expect(h.pdfStore.generation(a.id), "record kept while a pane shows the id").not.toBeNull();
		expect(h.pdfStore.strokes(a.id).map((s) => s.id)).toEqual(["desk1"]);
	});
});
