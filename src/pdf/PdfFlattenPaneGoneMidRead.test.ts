/**
 * Flatten takes the PDF's ink before it waits for the file, so a pane that closes or moves to another file during that
 * wait cannot leave it a copy with no ink that says "exported".
 *
 * The case: an inked PDF, "Flatten ink into a copy of this PDF". The command checks that the ink is ready and not empty,
 * then the flatten reads the whole file. On a phone or tablet that read waits its turn in the adapter's queue and can
 * take seconds. The user closes the pane, or opens another file in it. The close releases the PDF's id, nothing waits to
 * be saved, so the session record is forgotten at once. When the read lands, the flatten asked the store for the ink of
 * a record that is gone, got none, wrote the PDF's own bytes as `<name>.flattened.pdf` and said "exported". The PDF's
 * ink is safe in its ink file; the copy is wrong and the notice says it worked.
 *
 * Wanted: the copy holds the ink the command checked, the list as it stood when the command ran, whatever happens to the
 * pane, the record or the ink while the file is read (the pane closed, the tab switched, the PDF changed on disk, ink
 * drawn or erased). The list is taken as a copy, so a later change to the record cannot reach it. Never the source's own
 * bytes under "exported", and no refusal in place of the copy.
 *
 * Real code: the flatten command as registerExportSelectionCommands registers it, the real flattenPdf, firstFreePath and
 * appendInkToPdf, the real syncPdfControllers sweep and releasePdfId, resolvePdfId and pdfIdForPath, on a plugin built
 * without its constructor, over the real PageStore and PdfInkStore wired as main.ts wires them. Fakes: an in-memory
 * adapter with a one-level list(), the leaves, the controllers, the vault's readBinary (held on a promise for the
 * flatten's read) and createBinary (recorded).
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ notices: [] as string[] }));

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: string) {
			seen.notices.push(message);
		}
	},
}));

import HandwritingPlugin from "../main";
import { TFile } from "obsidian";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { appendInkToPdf } from "../ink/InkPdfAppend";
import type { InkStroke } from "../ink/Stroke";
import { document } from "../../test/pdf-fixture";

const A = "A.pdf";
const B = "B.pdf";
const bytesOfText = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
const A_BYTES = bytesOfText(document(1));
const B_BYTES = bytesOfText(document(2));
/** A's bytes after a sync replaces the file: a new document, so a new ink id. */
const A_CHANGED_BYTES = bytesOfText(document(3));

const vaultFile = (path: string) =>
	Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		name: path.split("/").pop(),
		basename: path.replace(/\.[^.]+$/, ""),
	});

function stroke(id: string, x: number): InkStroke {
	return {
		id, page: 1, tool: "pen", color: "#111111", width: 2, createdAt: 0,
		points: [{ x, y: 100, pressure: 0.5, t: 0 }, { x: x + 40, y: 140, pressure: 0.5, t: 8 }],
		bbox: { x, y: 100, width: 40, height: 40 },
	};
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** What a right copy of A holds: A's bytes with exactly these strokes flattened in. */
function copyOfA(strokes: readonly InkStroke[]): Uint8Array {
	const result = appendInkToPdf(A_BYTES, strokes, "darken");
	expect(result.ok, "precondition: A takes ink").toBe(true);
	const bytes = (result as { bytes: Uint8Array }).bytes;
	expect(same(bytes, A_BYTES), "precondition: ink changes A's bytes").toBe(false);
	return bytes;
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	seen.notices.length = 0;
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

type Command = { id: string; checkCallback: (checking: boolean) => boolean };

function harness() {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	adapter.list = async (folder: string) => ({
		files: [...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")),
		folders: [],
	});
	const store = new PageStore({ vault: { adapter } } as never);
	const pdfStore = new PdfInkStore();
	pdfStore.attachHost({
		load: (id, options) => store.load(id, options),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => {},
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing, "pdf"),
		acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
	});
	const pdfs = new Map<string, Uint8Array>([[A, A_BYTES], [B, B_BYTES]]);
	/** The next read of A waits here when armed: the flatten's read, queued behind the adapter's other work. */
	let armed = false;
	const heldReads: (() => void)[] = [];
	const writes: { path: string; bytes: Uint8Array }[] = [];
	const leaves: { view: { containerEl: HTMLElement; file: { path: string } } }[] = [];
	const app = {
		vault: {
			adapter,
			readBinary: async (file: { path: string }) => {
				const bytes = pdfs.get(file.path);
				if (!bytes) throw new Error(`no file ${file.path}`);
				if (armed && file.path === A) {
					armed = false;
					await new Promise<void>((resolve) => heldReads.push(resolve));
				}
				return bytes.slice().buffer;
			},
			getFileByPath: (p: string) => (pdfs.has(p) ? vaultFile(p) : null),
			createBinary: async (path: string, data: ArrayBuffer) => {
				if (await adapter.exists(path)) throw new Error(`${path} already exists`);
				writes.push({ path, bytes: new Uint8Array(data.slice(0)) });
				adapter.files.set(path, "");
				return vaultFile(path);
			},
		},
		workspace: {
			getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []),
			getActiveFile: () => vaultFile(A),
		},
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, {
		app, store, pdfStore, pdfInk: new Map(), pdfIds: new Map(), pdfFiles: new Map(),
		settings: { inkPdfColorMode: "darken" },
	});
	const commands = new Map<string, Command>();
	plugin.addCommand = (command: Command) => {
		commands.set(command.id, command);
		return command;
	};
	plugin.registerExportSelectionCommands();
	// The real flatten runs; only its promise is kept, so a cell can wait for the whole of it.
	const realFlatten = plugin.flattenPdf as (...args: unknown[]) => Promise<void>;
	let flattening: Promise<void> | undefined;
	plugin.flattenPdf = function (this: unknown, ...args: unknown[]) {
		flattening = realFlatten.apply(this, args);
		return flattening;
	};

	/** A pane showing A: the controller mount() would have built, then the real resolvePdfId. */
	async function openA() {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, unmount() {}, forgetHistory() {}, idle: true };
		const leaf = { view: { containerEl: root, file: { path: A } } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, A);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId(leaf, root, controller);
		const id = plugin.pdfIds.get(root) as string;
		expect(id, "precondition: A was identified").toBeTruthy();
		expect(pdfStore.inkReady(id), "precondition: A's ink is ready").toBe(true);
		return { root, leaf, id };
	}
	/** The pane closes: its leaf is gone and the next workspace sync runs the real sweep. */
	function close(root: HTMLElement) {
		leaves.splice(leaves.findIndex((l) => l.view.containerEl === root), 1);
		(root as unknown as { isConnected: boolean }).isConnected = false;
		plugin.syncPdfControllers();
	}
	/** The same pane opens B: the next workspace sync sees the new path on the old root. */
	function switchToB(leaf: { view: { file: { path: string } } }) {
		leaf.view.file = { path: B };
		plugin.syncPdfControllers();
	}
	/**
	 * A sync replaces A's bytes and the plugin's own change check runs. The flatten's read, already under way, still
	 * returns the bytes it started on.
	 */
	async function changeAOnDisk() {
		pdfs.set(A, A_CHANGED_BYTES);
		await plugin.onPdfModified(A);
	}
	/** "Flatten ink into a copy of this PDF", run on A, with the flatten's read held. */
	function flatten() {
		armed = true;
		seen.notices.length = 0;
		const command = commands.get("flatten-pdf-ink")!;
		expect(command.checkCallback(true), "premise: listed on a PDF").toBe(true);
		expect(command.checkCallback(false)).toBe(true);
	}
	async function readStarted() {
		await vi.waitFor(() => expect(heldReads.length, "precondition: the flatten is waiting on its read").toBe(1));
	}
	async function readLands() {
		heldReads.shift()!();
		await flattening;
	}
	return { store, pdfStore, plugin, openA, close, switchToB, changeAOnDisk, flatten, readStarted, readLands, writes, notices: seen.notices };
}

type H = ReturnType<typeof harness>;

/** Ink on A, on disk, so a close has nothing left to save and forgets the record at once. */
async function inkedA(h: H) {
	const a = await h.openA();
	const ink = [stroke("before-1", 100), stroke("before-2", 300)];
	h.pdfStore.replaceAll(a.id, ink);
	await h.store.flush();
	return { ...a, ink };
}

/** The flatten's outcome is a copy holding exactly `ink`, or no file and a notice that does not say "exported". */
function expectNoInklessCopy(h: H, ink: readonly InkStroke[]) {
	const exported = h.notices.filter((n) => n.startsWith("Handwriting: exported"));
	if (h.writes.length === 0) {
		expect(exported, "nothing was written, yet a notice says exported").toEqual([]);
		expect(h.notices.length, "nothing was written and nothing was said").toBeGreaterThan(0);
		return;
	}
	expect(h.writes.map((w) => w.path), "one copy, named after A").toEqual(["A.flattened.pdf"]);
	expect(same(h.writes[0]!.bytes, A_BYTES), "the copy is A's own bytes, no ink in it, and the notice says exported").toBe(false);
	expect(same(h.writes[0]!.bytes, copyOfA(ink)), "the copy does not hold the ink the command checked").toBe(true);
	expect(exported, "the copy was written and nothing said so").toHaveLength(1);
}

/**
 * The take route, held strictly: a copy holding exactly `ink` is written and called exported. A refusal is not this
 * route; it would need new words and cancels a copy the user asked for. Only the flatten's own notice is counted: a
 * change on disk says its own words about the carried ink.
 */
function expectCopyOfCheckedInk(h: H, ink: readonly InkStroke[]) {
	expect(h.writes.map((w) => w.path), "no copy was written: the flatten refused instead of taking the ink it checked").toEqual(["A.flattened.pdf"]);
	expect(same(h.writes[0]!.bytes, A_BYTES), "the copy is A's own bytes, no ink in it, and the notice says exported").toBe(false);
	expect(same(h.writes[0]!.bytes, copyOfA(ink)), "the copy does not hold the ink the command checked").toBe(true);
	expect(h.notices.filter((n) => n.startsWith("Handwriting: exported")), "the copy was written and nothing said so").toEqual(["Handwriting: exported A.flattened.pdf"]);
}

it("the pane left open: the copy holds A's ink and the notice says exported", async () => {
	const h = harness();
	const a = await inkedA(h);
	h.flatten();
	await h.readStarted();
	await h.readLands();
	expect(h.writes.map((w) => w.path)).toEqual(["A.flattened.pdf"]);
	expect(same(h.writes[0]!.bytes, copyOfA(a.ink)), "the copy does not hold A's ink").toBe(true);
	expect(h.notices).toEqual(["Handwriting: exported A.flattened.pdf"]);
});

it("the pane closed while the flatten reads the PDF: no copy without the ink is written and called exported", async () => {
	const h = harness();
	const a = await inkedA(h);
	h.flatten();
	await h.readStarted();
	h.close(a.root);
	await vi.waitFor(() =>
		expect(h.pdfStore.generation(a.id), "precondition: the close released A's ink record while the read waited").toBeNull()
	);
	await h.readLands();
	expectNoInklessCopy(h, a.ink);
});

it("the pane moved to another PDF while the flatten reads: no copy without the ink is written and called exported", async () => {
	const h = harness();
	const a = await inkedA(h);
	h.flatten();
	await h.readStarted();
	h.switchToB(a.leaf);
	await vi.waitFor(() =>
		expect(h.pdfStore.generation(a.id), "precondition: the switch released A's ink record while the read waited").toBeNull()
	);
	await vi.waitFor(() => expect(h.plugin.pdfIds.get(a.root), "precondition: the pane now shows B").toBeDefined());
	expect(h.plugin.pdfIds.get(a.root)).not.toBe(a.id);
	await h.readLands();
	expectNoInklessCopy(h, a.ink);
});

it("the strokes are taken before the read: a stroke drawn while the read waits is not in the copy", async () => {
	const h = harness();
	const a = await inkedA(h);
	h.flatten();
	await h.readStarted();
	h.pdfStore.replaceAll(a.id, [...h.pdfStore.strokes(a.id), stroke("after", 450)]);
	await h.readLands();
	expect(h.writes.map((w) => w.path)).toEqual(["A.flattened.pdf"]);
	expect(same(h.writes[0]!.bytes, copyOfA(a.ink)), "the copy holds ink drawn after the command: the strokes were taken after the read").toBe(true);
	expect(h.notices).toEqual(["Handwriting: exported A.flattened.pdf"]);
});

it("the PDF changed on disk while the flatten reads: the copy holds the ink the command checked", async () => {
	const h = harness();
	const a = await inkedA(h);
	h.flatten();
	await h.readStarted();
	await h.changeAOnDisk();
	await vi.waitFor(() =>
		expect(h.pdfStore.generation(a.id), "precondition: the change released A's old ink record while the read waited").toBeNull()
	);
	expect(h.plugin.pdfIds.get(a.root), "precondition: the pane moved to the new content's ink id").toBeDefined();
	expect(h.plugin.pdfIds.get(a.root)).not.toBe(a.id);
	await h.readLands();
	expectCopyOfCheckedInk(h, a.ink);
});

it("the list is taken as a copy: a stroke committed into the record's own list while the read waits is not in the copy", async () => {
	const h = harness();
	const a = await inkedA(h);
	h.flatten();
	await h.readStarted();
	h.pdfStore.commit(a.id, stroke("after", 450));
	expect(h.pdfStore.strokes(a.id).map((s) => s.id), "precondition: the commit added the stroke to A's list").toEqual(["before-1", "before-2", "after"]);
	await h.readLands();
	expect(h.writes.map((w) => w.path)).toEqual(["A.flattened.pdf"]);
	expect(same(h.writes[0]!.bytes, copyOfA(a.ink)), "the copy holds a stroke committed after the command: the list was not copied when the command ran").toBe(true);
	expect(h.notices).toEqual(["Handwriting: exported A.flattened.pdf"]);
});

it("the pane closed while the flatten reads: the copy holds the ink the command checked, not a refusal", async () => {
	const h = harness();
	const a = await inkedA(h);
	h.flatten();
	await h.readStarted();
	h.close(a.root);
	await vi.waitFor(() =>
		expect(h.pdfStore.generation(a.id), "precondition: the close released A's ink record while the read waited").toBeNull()
	);
	await h.readLands();
	expectCopyOfCheckedInk(h, a.ink);
});

it("the pane moved to another PDF while the flatten reads: the copy holds the ink the command checked, not a refusal", async () => {
	const h = harness();
	const a = await inkedA(h);
	h.flatten();
	await h.readStarted();
	h.switchToB(a.leaf);
	await vi.waitFor(() =>
		expect(h.pdfStore.generation(a.id), "precondition: the switch released A's ink record while the read waited").toBeNull()
	);
	await vi.waitFor(() => expect(h.plugin.pdfIds.get(a.root), "precondition: the pane now shows B").toBeDefined());
	expect(h.plugin.pdfIds.get(a.root)).not.toBe(a.id);
	await h.readLands();
	expectCopyOfCheckedInk(h, a.ink);
});
