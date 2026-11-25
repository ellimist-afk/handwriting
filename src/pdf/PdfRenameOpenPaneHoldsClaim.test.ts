// Pins beside the cells PdfRenameAfterFailedIdentify and PdfModifiedThenRenamed. A PDF renamed while a pane
// shows it: a pane still being identified moves its own claim, so no claim walk starts for it, and that holds while
// a newer identification of the pane is still running after an older one ended. A change still settling follows the
// file for the panes it was waiting on only: a pane already on the new version is not identified again, which would
// forget its undo. The harness is the one in PdfModifiedThenRenamed.test.ts: the plugin's own vault events, read
// from its source.
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

// The plugin's settle for a changed PDF (PdfClaims.ts, 1 s).
const SETTLE_MS = 1000;

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

const OLD = "Lecture.pdf";
const NEW = "Lecture annotated.pdf";

const vaultFile = (path: string) =>
	Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		name: path.split("/").pop(),
		basename: path.replace(/\.[^.]+$/, ""),
	});
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
	vi.clearAllTimers();
	vi.useRealTimers();
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

type Pane = {
	root: HTMLElement;
	leaf: { view: { file: TFile; containerEl: HTMLElement } };
	controller: { refresh(): void; refreshStrip(): void; forgetHistory(): void; idle: boolean; forgets: number };
	done: Promise<void>;
};

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
	const leaves: Pane["leaf"][] = [];
	const events = new Map<string, (...args: unknown[]) => void>();
	const detached: Promise<unknown>[] = [];
	// One entry per read of the PDF, in call order: a promise that read waits on, or null for none.
	const readGates: (Promise<void> | null)[] = [];
	const app = {
		workspace: { getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []) },
		vault: {
			adapter: v.adapter,
			getFiles: () => [...v.files].map((path) => ({ path, extension: "pdf" })),
			readBinary: async (_f: { path: string }) => {
				const gate = readGates.shift();
				if (gate) await gate;
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
	// Every identification pass the change timer starts, so a cell waits for the pass itself.
	const passes: Promise<void>[] = [];
	const onPdfModified = plugin.onPdfModified as (...args: unknown[]) => Promise<void>;
	plugin.onPdfModified = function (this: unknown, ...args: unknown[]) {
		const pass = onPdfModified.apply(this, args);
		passes.push(pass);
		return pass;
	};
	function start(file: TFile): Pane {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = {
			refresh() {}, refreshStrip() {}, idle: true, forgets: 0,
			forgetHistory() { controller.forgets++; },
		};
		const leaf = { view: { file, containerEl: root } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, file.path);
		plugin.pdfInk.set(root, controller);
		return { root, leaf, controller, done: plugin.resolvePdfId(leaf, root, controller) as Promise<void> };
	}
	/** The pane identified again over the identification it has (a sync of its leaf, a change on disk). */
	function again(pane: Pane): Promise<void> {
		return plugin.resolvePdfId(pane.leaf, pane.root, pane.controller) as Promise<void>;
	}
	function close(root: HTMLElement) {
		(root as unknown as { isConnected: boolean }).isConnected = false;
		leaves.splice(leaves.findIndex((l) => l.view.containerEl === root), 1);
		plugin.pdfInk.delete(root);
		plugin.pdfIds.delete(root);
		plugin.pdfFiles.delete(root);
	}
	/** One settle on the fake clock, then every pass it started, and anything detached, to its end. */
	async function settle() {
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		await Promise.all(passes);
		await Promise.all(detached);
		await vi.advanceTimersByTimeAsync(0);
	}
	return {
		store, pdfStore, plugin, start, again, close, settle, detached, readGates,
		send: (name: string, ...args: unknown[]) => events.get(name)?.(...args),
	};
}

/** Session 1: Lecture.pdf annotated and saved under its first content's id. */
async function annotated() {
	const v = vault();
	v.files.add(OLD);
	const s1 = session(v);
	const a = s1.start(vaultFile(OLD));
	await a.done;
	const id = s1.plugin.pdfIds.get(a.root) as string;
	s1.pdfStore.replaceAll(id, [stroke(10, "annotated")]);
	await s1.store.flush();
	s1.close(a.root);
	return { v, id };
}

/** Lecture.pdf -> Lecture annotated.pdf as Obsidian does: the TFile moved, then "rename". */
function rename(v: ReturnType<typeof vault>, s: ReturnType<typeof session>, file: TFile) {
	v.files.delete(OLD);
	v.files.add(NEW);
	Object.assign(file, vaultFile(NEW));
	s.send("rename", file, OLD);
}

it("renamed while its head is being read: no claim walk starts, and the identification moves the claim itself", async () => {
	const { v, id } = await annotated();
	const s2 = session(v);
	const walk = vi.spyOn(s2.plugin, "movePdfClaimOnRename");
	let release!: () => void;
	s2.readGates.push(new Promise<void>((r) => (release = r)));
	const file = vaultFile(OLD);
	const pane = s2.start(file);
	await new Promise((r) => setTimeout(r, 0));
	rename(v, s2, file);
	release();
	await pane.done;
	await Promise.all(s2.detached);
	await s2.store.flush();
	expect(walk, "a claim walk started for a pane still being identified").not.toHaveBeenCalled();
	expect(s2.plugin.pdfIds.get(pane.root)).toBe(id);
	expect(await s2.store.readPdfPaths(id), "the ink file still claims the name the file left").toEqual([NEW]);
});

it("an older identification of the pane ends while a newer one reads: a rename then starts no claim walk", async () => {
	const { v, id } = await annotated();
	const s2 = session(v);
	const walk = vi.spyOn(s2.plugin, "movePdfClaimOnRename");
	let release!: () => void;
	// The first identification reads at once; the second, started over it in the same pane, waits on its read.
	s2.readGates.push(null, new Promise<void>((r) => (release = r)));
	const file = vaultFile(OLD);
	const pane = s2.start(file);
	const second = s2.again(pane);
	// The first is overtaken and stops at its next guard.
	await pane.done;
	expect(s2.plugin.pdfIds.get(pane.root), "precondition: no id while the second reads").toBeUndefined();
	rename(v, s2, file);
	release();
	await second;
	await Promise.all(s2.detached);
	await s2.store.flush();
	expect(walk, "a claim walk started while the newer identification was still running").not.toHaveBeenCalled();
	expect(s2.plugin.pdfIds.get(pane.root)).toBe(id);
	expect(await s2.store.readPdfPaths(id), "the ink file still claims the name the file left").toEqual([NEW]);
});

it("changed on disk with one pane held, renamed inside the held pane's settle: only the held pane is identified again", async () => {
	const { v, id } = await annotated();
	vi.useFakeTimers();
	const s2 = session(v);
	const file = vaultFile(OLD);
	const first = s2.start(file);
	await first.done;
	const held = s2.start(file);
	await held.done;
	expect(s2.plugin.pdfIds.get(held.root), "precondition: both panes on the annotated file's id").toBe(id);
	held.controller.idle = false;

	v.pdfBytes = pdf("y".repeat(5000));
	s2.send("modify", file);
	await s2.settle();
	const moved = s2.plugin.pdfIds.get(first.root) as string;
	expect(moved, "precondition: the idle pane moved to the new content's id").not.toBe(id);
	expect(first.controller.forgets, "precondition: the idle pane identified once").toBe(1);
	expect(s2.plugin.pdfIds.get(held.root), "precondition: the held pane is left on the old one").toBe(id);

	rename(v, s2, file);
	held.controller.idle = true;
	await s2.settle();
	await s2.settle();

	expect(first.controller.forgets, "the pane already on the new version was identified again, its undo forgotten").toBe(1);
	expect(s2.plugin.pdfIds.get(first.root)).toBe(moved);
	expect(s2.plugin.pdfIds.get(held.root), "the held pane kept the old version's id past its settle").toBe(moved);
});
