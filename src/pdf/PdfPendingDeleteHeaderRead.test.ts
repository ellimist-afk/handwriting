/** Real pending-delete timer and PDF-header I/O on a disposable in-memory vault. */
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
import { familyOf, pdfInkId } from "./PdfIdentity";
import { parsePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

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
		bbox: { x: x - 4, y: 6, width: 18, height: 18 },
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
function rig(mode: "same" | "different" | "reject") {
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
	const different = new TextEncoder().encode("%PDF-1.7\nDIFFERENT\n" + "z".repeat(4100));
	const vault = { pdfPath: "Lecture.pdf" };
	const leaves: { view: { containerEl: HTMLElement; file: { path: string } } }[] = [];
	const app = {
		vault: {
			adapter,
			readBinary: vi.fn(async (file: { path: string }) => {
                if (file.path === "Lecture-renamed.pdf") {
                    if (mode === "reject") throw new Error("D4 fixture: PDF header unavailable");
                    if (mode === "different") return different.slice().buffer;
                }
                return bytes.slice().buffer;
            }),
			getFileByPath: (p: string) => (p === vault.pdfPath ? { path: p, extension: "pdf" } : null),
            getFiles: () => [{ path: vault.pdfPath, extension: "pdf" }],
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
	return { adapter, store, pdfStore, plugin, vault, open, close, bytes, different, app };
}

const cases = [
 ["a readable same-family recreated PDF transfers the claim and keeps its ink", "same"],
 ["a readable different-family recreated PDF retires the old claim recoverably", "different"],
 ["a recreated PDF whose header read rejects keeps the live ink and old claim", "reject"],
 ["an unreadable recreated PDF retains the pending deletion claim", "reject"],
] as const;

describe("PDF pending deletion after a recreated path", () => {
 it.each(cases)("%s", async (_name, mode) => {
  const r = rig(mode);
  let settled: Promise<void> | undefined;
  try {
   const opened = await r.open();
   const ink = stroke("desk1", 10);
   r.pdfStore.replaceAll(opened.id, [ink]);
   await r.store.flush();
   r.close(opened.root);
   await vi.waitFor(() => expect(r.pdfStore.generation(opened.id)).toBeNull());
   await r.store.flush();
   const livePath = `.handwriting/${opened.id}.json`;
   const initialBytes = r.adapter.files.get(livePath)!;
   expect(typeof initialBytes).toBe("string");
   const initial = parsePage(initialBytes, opened.id).data;
   expect(initial.pageId).toBe(opened.id);
   expect(initial.strokes).toEqual([ink]);
   expect(initial.pdfPaths).toEqual(["Lecture.pdf"]);
   expect([...r.adapter.files.keys()]).toEqual([livePath]);
   expect(r.app.vault.getFiles().map((f) => f.path)).toEqual(["Lecture.pdf"]);
   const trashPaths = () => [...r.adapter.files.keys()].filter((p) => p.includes("/trash/"));
   expect(trashPaths()).toEqual([]);
   const sameFamily = await pdfInkId(r.bytes, window.crypto);
   const otherFamily = await pdfInkId(r.different, window.crypto);
   expect(familyOf(opened.id)).toBe(sameFamily);
   expect(otherFamily).not.toBe(sameFamily);

   r.vault.pdfPath = "Lecture-renamed.pdf";
   expect(r.app.vault.getFileByPath("Lecture.pdf")).toBeNull();
   expect(r.app.vault.getFileByPath("Lecture-renamed.pdf")).toEqual({ path: "Lecture-renamed.pdf", extension: "pdf" });
   expect(r.app.vault.getFiles().map((f) => f.path)).toEqual(["Lecture-renamed.pdf"]);
   const context = r.plugin.pdfDeleteContext();
   const familyRead = vi.spyOn(context, "familyForPath");
   const remove = vi.spyOn(r.store, "remove");
   r.app.vault.readBinary.mockClear();
   // Observe the real timer's retirement without replacing its behavior or result.
   const observed = r.pdfStore as unknown as {
    retireDeletedPath(...args: unknown[]): Promise<void>;
   };
   const original = observed.retireDeletedPath;
   let resolveSettled!: () => void;
   let rejectSettled!: (reason: unknown) => void;
   settled = new Promise<void>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
   });
   const retirement = vi.spyOn(observed, "retireDeletedPath").mockImplementation(function (...args) {
    const result = original.apply(observed, args);
    void result.then(resolveSettled, rejectSettled);
    return result;
   });
   r.pdfStore.markDeletedPath("Lecture.pdf", { ...context, graceMs: 0 }, ["Lecture.pdf"]);
   await settled;
   await r.store.flush();
   expect(retirement).toHaveBeenCalledTimes(1);
   expect(retirement.mock.calls[0]![0]).toBe("Lecture.pdf");
   expect(familyRead).toHaveBeenCalledExactlyOnceWith("Lecture-renamed.pdf");
   expect(r.app.vault.readBinary).toHaveBeenCalledTimes(1);
   expect(r.app.vault.readBinary.mock.calls[0]![0].path).toBe("Lecture-renamed.pdf");
   const familyResult = familyRead.mock.results[0]!.value;
   if (mode === "reject") {
    await expect(familyResult).rejects.toThrow("D4 fixture: PDF header unavailable");
   } else {
    await expect(familyResult).resolves.toBe(mode === "same" ? sameFamily : otherFamily);
   }
   const liveBytes = r.adapter.files.get(livePath) ?? null;
   const live = liveBytes === null ? null : parsePage(liveBytes, opened.id).data;
   const trash = trashPaths().map((path) => {
    const bytes = r.adapter.files.get(path)!;
    return { path, bytes, data: parsePage(bytes, opened.id).data };
   });
   const observation = {
    removeIds: remove.mock.calls.map(([id]) => id),
    liveBytes,
    live: live === null ? null : { id: live.pageId, strokes: live.strokes, pdfPaths: live.pdfPaths },
    newTrashPaths: trash.map((t) => t.path),
   };
   if (mode === "same") {
    expect(observation.removeIds).toEqual([]);
    expect(observation.live).toEqual({ id: opened.id, strokes: [ink], pdfPaths: ["Lecture-renamed.pdf"] });
    expect(observation.newTrashPaths).toEqual([]);
   } else if (mode === "different") {
    expect(observation.removeIds).toEqual([opened.id]);
    expect(observation.liveBytes).toBeNull();
    expect(trash).toHaveLength(1);
    expect(trash[0]!.data.pageId).toBe(opened.id);
    expect(trash[0]!.data.strokes).toEqual([ink]);
    expect(trash[0]!.data.pdfPaths).toEqual(["Lecture.pdf"]);
     expect(await r.store.readPdfPaths(opened.id)).toBeNull();
   } else {
    // All consumed-I/O and lifecycle controls precede this single safety oracle.
    expect(observation).toEqual({
     removeIds: [], liveBytes: initialBytes,
     live: { id: initial.pageId, strokes: initial.strokes, pdfPaths: initial.pdfPaths },
     newTrashPaths: [],
    });
    if (_name === "an unreadable recreated PDF retains the pending deletion claim") {
     expect(r.pdfStore.pendingClaims()).toEqual(new Map([["Lecture.pdf", new Set(["Lecture.pdf"])]]));
    }
   }
  } finally {
   r.pdfStore.cancelPendingDeletes();
   if (settled) await settled.catch(() => undefined);
   await r.store.flush();
  }
 });
});
