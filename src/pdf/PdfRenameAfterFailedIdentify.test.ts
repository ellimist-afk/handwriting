// A PDF whose pane could not be identified (its ink file's claim unreadable mid-sync, or its head read failing)
// stays open with no ink id. Renamed then, nothing moves the ink file's claim, and the reopen the notice asks
// for adopts the ink file at the new name while its claim still holds the old one. A later file with the same
// bytes at the old name then opens wearing this file's ink. The harness is the one in
// PdfRenameDuringIdentifyKeepsOldClaim.test.ts: the plugin's own vault events, read from its source.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(_message: string) {}
	},
}));

import HandwritingPlugin from "../main";
import { TFile } from "obsidian";
import mainSource from "../main.ts?raw";
import onloadSource from "../PluginOnload.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { isMarkdownPath } from "../util/MarkdownPath";
import type { InkStroke } from "../ink/Stroke";

// The onload phases live in PluginOnload.ts, read here with main.ts.
const source = [mainSource, onloadSource].join("\n").replace(/\r\n/g, "\n");
const eventsStart =
	'\t\tthis.registerEvent(\n\t\t\tthis.app.vault.on("rename", (file, oldPath) => {\n\t\t\t\tif (file instanceof TFile && file.extension === "md") {\n\t\t\t\t\tinlineInk.handleRename(';
const eventsEnd = "\t\t\tthis.pdfModifyTimers?.clear();\n\t\t});";
expect(source.split(eventsStart)).toHaveLength(2);
const eventsAt = source.indexOf(eventsStart);
const eventsStop = source.indexOf(eventsEnd, eventsAt);
const installVaultEvents = new Function(
	"TFile",
	"inlineInk",
	"embedInkRenamed",
	"surfaceExtents",
	"runDetached",
	"isMarkdownPath",
	source.slice(eventsAt, eventsStop + eventsEnd.length)
);

const vaultFile = (path: string) =>
	Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		name: path.split("/").pop(),
		basename: path.replace(/\.[^.]+$/, ""),
	});
function moveTo(file: TFile, path: string): void {
	Object.assign(file, vaultFile(path));
}
function stroke(x: number, id: string): InkStroke {
	return {
		id, page: 1, tool: "pen", color: "#111111", width: 2, createdAt: 0,
		points: [{ x, y: 10, pressure: 0.5, t: 0 }, { x: x + 10, y: 20, pressure: 0.5, t: 8 }],
		bbox: { x, y: 10, width: 10, height: 10 },
	};
}
const pdf = (fill: string) =>
	new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + fill + "\n%%EOF\n");

beforeEach(() => vi.stubGlobal("window", globalThis));
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function vault() {
	const adapter = new FakeAdapter() as FakeAdapter & { list(folder: string): Promise<{ files: string[]; folders: string[] }> };
	adapter.list = async (folder: string) => ({
		files: [...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")),
		folders: [],
	});
	return { adapter, pdfBytes: pdf("x".repeat(5000)), files: new Set<string>() };
}

function session(v: ReturnType<typeof vault>) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	const pdfStore = new PdfInkStore();
	pdfStore.attachHost({
		load: (id, options) => store.load(id, options),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => {},
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing, "pdf"),
		acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
	});
	const leaves: { view: { file: TFile; containerEl: HTMLElement } }[] = [];
	const events = new Map<string, (...args: unknown[]) => void>();
	const detached: Promise<unknown>[] = [];
	let readGate: Promise<void> | null = null;
	const app = {
		workspace: { getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []) },
		vault: {
			adapter: v.adapter,
			getFiles: () => [...v.files].map((path) => ({ path, extension: "pdf" })),
			readBinary: async (_f: { path: string }) => {
				if (readGate) await readGate;
				return v.pdfBytes.slice().buffer;
			},
			getFileByPath: (p: string) => (v.files.has(p) ? { path: p, extension: "pdf" } : null),
			on: (name: string, handler: (...args: unknown[]) => void) => {
				events.set(name, handler);
				return { name };
			},
		},
	};
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, {
		app, store, pdfStore, pdfInk: new Map(), pdfIds: new Map(), pdfFiles: new Map(),
		settings: { inkPdfColorMode: "darken" },
		registerEvent: () => {},
		register: () => {},
	});
	installVaultEvents.call(plugin, TFile, {}, () => {}, {}, (work: Promise<unknown>) => detached.push(work), isMarkdownPath);
	function start(file: TFile) {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, forgetHistory() {}, idle: true };
		const leaf = { view: { file, containerEl: root } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, file.path);
		plugin.pdfInk.set(root, controller);
		return { root, done: plugin.resolvePdfId(leaf, root, controller) as Promise<void> };
	}
	async function open(path: string) {
		const s = start(vaultFile(path));
		await s.done;
		return { root: s.root, id: plugin.pdfIds.get(s.root) as string };
	}
	function close(root: HTMLElement) {
		(root as unknown as { isConnected: boolean }).isConnected = false;
		leaves.splice(leaves.findIndex((l) => l.view.containerEl === root), 1);
		plugin.pdfInk.delete(root);
		plugin.pdfIds.delete(root);
		plugin.pdfFiles.delete(root);
	}
	return {
		store, pdfStore, plugin, start, open, close, detached,
		send: (name: string, ...args: unknown[]) => events.get(name)?.(...args),
		gateReads(g: Promise<void> | null) { readGate = g; },
	};
}

/** Session 1: Lecture.pdf annotated and saved; its sidecar claims "Lecture.pdf". */
async function annotated() {
	const v = vault();
	v.files.add("Lecture.pdf");
	const s1 = session(v);
	const a = await s1.open("Lecture.pdf");
	s1.pdfStore.replaceAll(a.id, [stroke(10, "annotated")]);
	await s1.store.flush();
	s1.close(a.root);
	return { v, id: a.id };
}

/** Rename Lecture.pdf -> Lecture annotated.pdf as Obsidian does: TFile moved, then "rename". */
function rename(v: ReturnType<typeof vault>, s: ReturnType<typeof session>, file: TFile) {
	v.files.delete("Lecture.pdf");
	v.files.add("Lecture annotated.pdf");
	moveTo(file, "Lecture annotated.pdf");
	s.send("rename", file, "Lecture.pdf");
}

/** Session 3: a same-bytes file appears at the old name again (re-download, re-export). */
async function reuseOldName(v: ReturnType<typeof vault>) {
	v.files.add("Lecture.pdf");
	const s3 = session(v);
	const fresh = await s3.open("Lecture.pdf");
	const renamed = await s3.open("Lecture annotated.pdf");
	return { s3, fresh, renamed };
}

/** Session 2: a pane on Lecture.pdf whose identification fails once, renamed while it is still open, then reopened. */
async function failedThenRenamed(fail: "claim" | "head") {
	const { v, id } = await annotated();
	const s2 = session(v);
	if (fail === "claim") {
		const read = s2.store.readPdfPaths.bind(s2.store);
		let failed = false;
		vi.spyOn(s2.store, "readPdfPaths").mockImplementation(async (pageId) => {
			if (!failed) {
				failed = true;
				return null;
			}
			return read(pageId);
		});
	} else {
		const readBinary = s2.plugin.app.vault.readBinary;
		let failed = false;
		s2.plugin.app.vault.readBinary = async (f: { path: string }) => {
			if (!failed) {
				failed = true;
				throw new Error("EIO injected");
			}
			return readBinary(f);
		};
	}
	const file = vaultFile("Lecture.pdf");
	const pane = s2.start(file);
	const outcome = await pane.done.then(() => "identified", () => "failed");
	return { v, id, s2, file, pane, outcome };
}

for (const fail of ["claim", "head"] as const) {
	it(`identification failed (${fail} read), renamed while open, then reopened: the ink file claims only the new name`, async () => {
		const { v, id, s2, file, pane, outcome } = await failedThenRenamed(fail);
		expect(outcome, "precondition: the pane's identification failed").toBe("failed");
		expect(s2.plugin.pdfIds.get(pane.root), "precondition: the pane has no ink id").toBeUndefined();
		rename(v, s2, file);
		await Promise.all(s2.detached);
		s2.close(pane.root);
		const reopened = await s2.open("Lecture annotated.pdf");
		expect(reopened.id, "precondition: the reopen took the renamed file's ink").toBe(id);
		await Promise.all(s2.detached);
		await s2.store.flush();
		// Soft, so the user-visible end below is read even when the claim is wrong.
		expect.soft(await s2.store.readPdfPaths(id), "the ink file still claims the name the file left").toEqual(["Lecture annotated.pdf"]);
		const { s3, fresh, renamed } = await reuseOldName(v);
		expect(s3.pdfStore.strokes(fresh.id).map((s) => s.id), "a new file at the old name opened wearing the renamed file's ink").toEqual([]);
		expect(s3.pdfStore.strokes(renamed.id).map((s) => s.id), "the renamed file lost its ink").toEqual(["annotated"]);
	});
}

it("CONTROL: identified, renamed while open, then reopened: the ink file claims only the new name", async () => {
	const { v, id } = await annotated();
	const s2 = session(v);
	const file = vaultFile("Lecture.pdf");
	const pane = s2.start(file);
	await pane.done;
	expect(s2.plugin.pdfIds.get(pane.root), "precondition: the pane is identified").toBe(id);
	rename(v, s2, file);
	await Promise.all(s2.detached);
	s2.close(pane.root);
	const reopened = await s2.open("Lecture annotated.pdf");
	expect(reopened.id).toBe(id);
	await Promise.all(s2.detached);
	await s2.store.flush();
	expect(await s2.store.readPdfPaths(id)).toEqual(["Lecture annotated.pdf"]);
	const { s3, fresh, renamed } = await reuseOldName(v);
	expect(s3.pdfStore.strokes(fresh.id).map((s) => s.id)).toEqual([]);
	expect(s3.pdfStore.strokes(renamed.id).map((s) => s.id)).toEqual(["annotated"]);
});
