// A PDF whose bytes change on disk while a pane shows it waits a settle, then its panes are identified again under
// the new content. Renamed inside that settle, the panes are still on it at the new name. Want: no pane keeps the old
// version's id past the settle, a pane held mid-gesture included, and a stroke drawn in that pane after pen-up is
// shown when the file is reopened. Controls: the same with no rename. The harness is the one in
// PdfRenameAfterFailedIdentify.test.ts: the plugin's own vault events, read from its source, on a fake clock.
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
const ids = (strokes: readonly InkStroke[]) => strokes.map((s) => s.id);

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});
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
	const app = {
		workspace: { getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []) },
		vault: {
			adapter: v.adapter,
			getFiles: () => [...v.files].map((path) => ({ path, extension: "pdf" })),
			readBinary: async (_f: { path: string }) => v.pdfBytes.slice().buffer,
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
	// Every identification pass the change timer starts, so a cell waits for the pass itself (it reads and hashes
	// the file, real async work the fake clock does not drive).
	const passes: Promise<void>[] = [];
	const onPdfModified = plugin.onPdfModified as (...args: unknown[]) => Promise<void>;
	plugin.onPdfModified = function (this: unknown, ...args: unknown[]) {
		const pass = onPdfModified.apply(this, args);
		passes.push(pass);
		return pass;
	};
	async function open(file: TFile) {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, forgetHistory() {}, idle: true };
		const leaf = { view: { file, containerEl: root } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, file.path);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId(leaf, root, controller);
		return { root, controller, id: plugin.pdfIds.get(root) as string };
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
		store, pdfStore, plugin, open, close, settle, passes,
		send: (name: string, ...args: unknown[]) => events.get(name)?.(...args),
	};
}

/** Session 1: Lecture.pdf annotated and saved under its first content's id. */
async function annotated() {
	const v = vault();
	v.files.add(OLD);
	const s1 = session(v);
	const a = await s1.open(vaultFile(OLD));
	s1.pdfStore.replaceAll(a.id, [stroke(10, "annotated")]);
	await s1.store.flush();
	s1.close(a.root);
	await vi.advanceTimersByTimeAsync(5000);
	return { v, id: a.id };
}

/** New bytes land in place (a sync, a re-export over the file): Obsidian sends "modify". */
function change(v: ReturnType<typeof vault>, s: ReturnType<typeof session>, file: TFile) {
	v.pdfBytes = pdf("y".repeat(5000));
	s.send("modify", file);
}

/** Lecture.pdf -> Lecture annotated.pdf as Obsidian does: the TFile moved, then "rename". */
function rename(v: ReturnType<typeof vault>, s: ReturnType<typeof session>, file: TFile) {
	v.files.delete(OLD);
	v.files.add(NEW);
	Object.assign(file, vaultFile(NEW));
	s.send("rename", file, OLD);
}

/** The id a fresh session gives the file's bytes as they are now, at `path`. */
async function freshId(v: ReturnType<typeof vault>, path: string): Promise<string> {
	const s = session(v);
	const o = await s.open(vaultFile(path));
	return o.id;
}

for (const renamed of [true, false]) {
	const label = renamed ? "renamed inside the settle" : "CONTROL: not renamed";
	it(`changed on disk, ${label}: after the settle the pane is not on the old version's id`, async () => {
		const { v, id } = await annotated();
		const s2 = session(v);
		const file = vaultFile(OLD);
		const pane = await s2.open(file);
		expect(pane.id, "precondition: the pane opened on the annotated file's id").toBe(id);

		change(v, s2, file);
		if (renamed) rename(v, s2, file);
		await s2.settle();
		await s2.settle();

		const now = s2.plugin.pdfIds.get(pane.root);
		expect.soft(now, "the pane kept the old version's id past the settle").not.toBe(id);
		expect.soft(now, "the pane is not on the id the file's new bytes have").toBe(await freshId(v, renamed ? NEW : OLD));
	});

	it(`two panes, one held mid-gesture, changed on disk, ${label}: a stroke drawn in the held pane after pen-up is shown on reopen`, async () => {
		const { v, id } = await annotated();
		const s2 = session(v);
		const file = vaultFile(OLD);
		const first = await s2.open(file);
		const held = await s2.open(file);
		expect(held.id, "precondition: both panes on the annotated file's id").toBe(id);
		held.controller.idle = false;

		change(v, s2, file);
		await s2.settle();
		expect(s2.plugin.pdfIds.get(first.root), "precondition: the idle pane moved to the new content's id").not.toBe(id);
		expect(s2.plugin.pdfIds.get(held.root), "precondition: the held pane is left on the old one").toBe(id);

		if (renamed) rename(v, s2, file);
		held.controller.idle = true;
		await s2.settle();
		await s2.settle();

		const heldNow = s2.plugin.pdfIds.get(held.root) as string;
		expect.soft(heldNow, "the held pane kept the old version's id past its settle").not.toBe(id);
		s2.pdfStore.commit(heldNow, stroke(40, "after-pen-up"));
		await s2.store.flush();
		s2.close(first.root);
		s2.close(held.root);
		await vi.advanceTimersByTimeAsync(5000);
		await s2.store.flush();

		const s3 = session(v);
		const reopened = await s3.open(vaultFile(renamed ? NEW : OLD));
		expect(ids(s3.pdfStore.strokes(reopened.id)).sort(), "the reopened file does not show the stroke drawn in the held pane, or lost its ink").toEqual(["after-pen-up", "annotated"]);
	});
}
