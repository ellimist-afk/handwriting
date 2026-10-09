/**
 * A closed PDF's ink record is forgotten once its save lands, so the next open
 * reads the sidecar as it is then, other devices' ink included. Two paths load
 * the record of a PDF no pane shows and keep it: a rename made in the vault
 * while the PDF is closed, and a delete then create of the same bytes under a
 * new name (a sync client's rename) once its grace runs out. Ink another device
 * adds meanwhile is then missing when the PDF reopens, and the next stroke here
 * saves over it, which leaves that ink only in a conflict file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(_message: string) {}
	},
}));

import HandwritingPlugin from "./main";
import { PageStore } from "./persistence/PageStore";
import { FakeAdapter } from "./persistence/FakeAdapter";
import { PdfInkStore } from "./pdf/PdfInkStore";
import { familyOf } from "./pdf/PdfIdentity";
import { parsePage, serializePage } from "./model/PageData";
import type { InkStroke } from "./ink/Stroke";

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

/** The plugin's PDF identification over a real PageStore and PdfInkStore on a fake vault holding one PDF. */
function rig() {
	const adapter = new FakeAdapter() as FakeAdapter & { list(f: string): Promise<{ files: string[]; folders: string[] }> };
	adapter.list = async (folder: string) => ({
		files: [...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")),
		folders: [],
	});
	const store = new PageStore({ vault: { adapter } } as never);
	const pdfStore = new PdfInkStore();
	pdfStore.attachHost({
		load: (id) => store.load(id),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => {},
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing, "pdf"),
		acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
	});
	const bytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + "y".repeat(4000) + "\n%%EOF\n");
	const vault = { pdfPath: "Lecture.pdf" };
	const leaves: { view: { containerEl: HTMLElement; file: { path: string } } }[] = [];
	const app = {
		vault: {
			adapter,
			readBinary: async () => bytes.slice().buffer,
			getFileByPath: (p: string) => (p === vault.pdfPath ? { path: p } : null),
		},
		workspace: { getLeavesOfType: (t: string) => (t === "pdf" ? leaves : []) },
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, { app, store, pdfStore, pdfInk: new Map(), pdfIds: new Map(), pdfFiles: new Map() });
	const open = async () => {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, unmount() {}, forgetHistory() {}, idle: true };
		leaves.push({ view: { containerEl: root, file: { path: vault.pdfPath } } });
		plugin.pdfFiles.set(root, vault.pdfPath);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId({ view: { file: { path: vault.pdfPath } } }, root, controller);
		return { root, id: plugin.pdfIds.get(root) as string };
	};
	const close = (root: HTMLElement) => {
		leaves.splice(
			leaves.findIndex((l) => l.view.containerEl === root),
			1
		);
		(root as unknown as { isConnected: boolean }).isConnected = false;
		plugin.syncPdfControllers();
	};
	/** Another device adds `strokeId` to the sidecar, and it syncs in. */
	const otherDeviceAdds = (id: string, strokeId: string) => {
		const live = `.handwriting/${id}.json`;
		const synced = parsePage(adapter.files.get(live)!, id).data;
		synced.strokes = [...synced.strokes, stroke(strokeId, 60)];
		adapter.externalWrite(live, serializePage(synced));
	};
	const onDisk = (id: string) => parsePage(adapter.files.get(`.handwriting/${id}.json`)!, id).data.strokes.map((s) => s.id);
	return { adapter, store, pdfStore, plugin, vault, open, close, otherDeviceAdds, onDisk };
}

describe("a closed PDF whose record a rename loaded, reopened after another device added ink", () => {
	it("renamed in the vault while closed: the other device's ink shows, and the next stroke keeps it", async () => {
		const r = rig();
		const a = await r.open();
		r.pdfStore.replaceAll(a.id, [stroke("desk1", 10)]);
		r.close(a.root);
		await vi.waitFor(() => expect(r.pdfStore.generation(a.id), "precondition: the closed PDF's record is forgotten").toBeNull());

		// Renamed in the file explorer while no pane shows it.
		r.vault.pdfPath = "Lecture (week 1).pdf";
		await r.plugin.movePdfClaimOnRename({ path: r.vault.pdfPath }, "Lecture.pdf");
		await r.store.flush();

		r.otherDeviceAdds(a.id, "tablet1");

		const b = await r.open();
		expect(b.id, "precondition: the renamed file keeps its ink id").toBe(a.id);
		expect(r.pdfStore.strokes(b.id).map((s) => s.id), "the other device's ink is not on screen").toEqual(["desk1", "tablet1"]);
		r.pdfStore.replaceAll(b.id, [...r.pdfStore.strokes(b.id), stroke("desk2", 110)]);
		await r.store.flush();
		expect(r.onDisk(a.id), "the next stroke saved over the other device's ink").toEqual(["desk1", "tablet1", "desk2"]);
	});

	it("deleted and created again under a new name while closed: the other device's ink shows, and the next stroke keeps it", async () => {
		const r = rig();
		const a = await r.open();
		r.pdfStore.replaceAll(a.id, [stroke("desk1", 10)]);
		r.close(a.root);
		await vi.waitFor(() => expect(r.pdfStore.generation(a.id), "precondition: the closed PDF's record is forgotten").toBeNull());

		// A sync client's rename: the old path is deleted, the same bytes are created at a new one.
		r.vault.pdfPath = "Lecture (week 1).pdf";
		// The store and the release are the plugin's own; the vault listing,
		// the family read and the grace are this rig's.
		const wired = r.plugin.pdfDeleteContext();
		r.pdfStore.markDeletedPath(
			"Lecture.pdf",
			{
				store: wired.store,
				release: wired.release,
				listPdfPaths: () => [r.vault.pdfPath],
				familyForPath: async () => familyOf(a.id),
				graceMs: 0,
			},
			["Lecture.pdf"]
		);
		await vi.waitFor(() => expect(r.pdfStore.pendingClaims().has("Lecture.pdf"), "precondition: the deletion's grace ran out").toBe(false));
		await r.store.flush();

		r.otherDeviceAdds(a.id, "tablet1");

		const b = await r.open();
		expect(b.id, "precondition: the new name keeps the ink id").toBe(a.id);
		expect(r.pdfStore.strokes(b.id).map((s) => s.id), "the other device's ink is not on screen").toEqual(["desk1", "tablet1"]);
		r.pdfStore.replaceAll(b.id, [...r.pdfStore.strokes(b.id), stroke("desk2", 110)]);
		await r.store.flush();
		expect(r.onDisk(a.id), "the next stroke saved over the other device's ink").toEqual(["desk1", "tablet1", "desk2"]);
	});
});

describe("a record loaded for a closed PDF is let go on every path", () => {
	it("a rename that loads a record and then finds it no longer claims the old name lets it go", async () => {
		const r = rig();
		const a = await r.open();
		r.pdfStore.replaceAll(a.id, [stroke("desk1", 10)]);
		r.close(a.root);
		await vi.waitFor(() => expect(r.pdfStore.generation(a.id), "precondition: the closed PDF's record is forgotten").toBeNull());

		// The sidecar's claim moved elsewhere (another device), but the first read still saw the old name.
		const live = `.handwriting/${a.id}.json`;
		const page = parsePage(r.adapter.files.get(live)!, a.id).data;
		page.pdfPaths = ["Elsewhere.pdf"];
		r.adapter.externalWrite(live, serializePage(page));
		const read = r.store.readPdfPaths.bind(r.store);
		r.store.readPdfPaths = async (id: string) => (id === a.id ? ["Lecture.pdf"] : read(id));

		r.vault.pdfPath = "Lecture (week 1).pdf";
		await r.plugin.movePdfClaimOnRename({ path: r.vault.pdfPath }, "Lecture.pdf");
		await r.store.flush();

		expect(parsePage(r.adapter.files.get(live)!, a.id).data.pdfPaths, "precondition: the claim was not moved").toEqual(["Elsewhere.pdf"]);
		await vi.waitFor(() => expect(r.pdfStore.generation(a.id), "the record the rename loaded and skipped was kept").toBeNull());
	});

	it("a retirement that stops early after loading a record lets it go", async () => {
		const r = rig();
		const a = await r.open();
		r.pdfStore.replaceAll(a.id, [stroke("desk1", 10)]);
		r.close(a.root);
		await vi.waitFor(() => expect(r.pdfStore.generation(a.id), "precondition: the closed PDF's record is forgotten").toBeNull());

		// The record's load is held, so a second deletion of the same path can land while it runs.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let loading = false;
		const load = r.store.load.bind(r.store);
		r.store.load = (async (id: string, options?: { restore?: boolean }) => {
			if (id === a.id) {
				loading = true;
				await gate;
			}
			return load(id, options);
		}) as typeof r.store.load;

		r.vault.pdfPath = "Lecture (week 1).pdf";
		const wired = r.plugin.pdfDeleteContext();
		const context = {
			store: wired.store,
			release: wired.release,
			listPdfPaths: () => [r.vault.pdfPath],
			familyForPath: async () => familyOf(a.id),
			graceMs: 0,
		};
		r.pdfStore.markDeletedPath("Lecture.pdf", context, ["Lecture.pdf"]);
		await vi.waitFor(() => expect(loading, "precondition: the retirement is loading the record").toBe(true));
		// The same path is deleted again: the running retirement is no longer the current one.
		r.pdfStore.markDeletedPath("Lecture.pdf", { ...context, graceMs: 60_000 }, ["Lecture.pdf"]);
		release();

		await vi.waitFor(() => expect(r.pdfStore.generation(a.id), "the record the stopped retirement loaded was kept").toBeNull());
		expect(parsePage(r.adapter.files.get(`.handwriting/${a.id}.json`)!, a.id).data.pdfPaths, "precondition: the stopped retirement moved nothing").toEqual(["Lecture.pdf"]);
		r.pdfStore.cancelPendingDeletes();
	});
});

describe("a deleted PDF's retirement while a file with the same bytes opens", () => {
	it("a same-content PDF that adopts the ink while the deleted claim's sidecar is being removed keeps its record", async () => {
		const r = rig();
		const a = await r.open();
		r.pdfStore.replaceAll(a.id, [stroke("desk1", 10)]);
		await r.store.flush();
		r.close(a.root);
		await vi.waitFor(() => expect(r.pdfStore.generation(a.id), "precondition: the closed PDF's record is forgotten").toBeNull());

		// The sidecar removal is held, so a file with the same bytes can open during it.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let removing = false;
		let removed = false;
		const remove = r.store.remove.bind(r.store);
		r.store.remove = (async (id: string) => {
			removing = true;
			await gate;
			await remove(id);
			removed = true;
		}) as typeof r.store.remove;

		const wired = r.plugin.pdfDeleteContext();
		r.pdfStore.markDeletedPath("Lecture.pdf", {
			store: wired.store,
			release: wired.release,
			listPdfPaths: () => [],
			familyForPath: async () => familyOf(a.id),
			graceMs: 0,
		}, ["Lecture.pdf"]);
		await vi.waitFor(() => expect(removing, "precondition: the retirement is removing the sidecar").toBe(true));

		r.vault.pdfPath = "Lecture copy.pdf";
		const b = await r.open();
		expect(b.id, "precondition: the copy adopted the deleted file's ink").toBe(a.id);
		release();
		await vi.waitFor(() => expect(removed).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(r.pdfStore.generation(b.id), "the retirement deleted the record the open copy is drawing on").not.toBeNull();
		expect(r.pdfStore.strokes(b.id).map((s) => s.id), "the open copy's ink left the screen").toEqual(["desk1"]);
		// The removal still took the sidecar off disk. The kept record is
		// written back at once, with no new stroke to make it save.
		await r.store.flush();
		await new Promise((resolve) => setTimeout(resolve, 50));
		await r.store.flush();
		const sidecar = r.adapter.files.get(`.handwriting/${b.id}.json`);
		expect(sidecar, "the kept record's ink file stays deleted until its next edit").toBeDefined();
		expect(parsePage(sidecar!, b.id).data.strokes.map((s) => s.id), "the ink file written back lost the ink").toEqual(["desk1"]);
		r.pdfStore.cancelPendingDeletes();
	});
});
