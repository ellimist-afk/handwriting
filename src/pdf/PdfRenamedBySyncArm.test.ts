/**
 * A PDF renamed on another device, outside Obsidian, and brought in by a sync tool, which delivers the rename as a
 * delete of the old name and a create of the new one, in either order and with any gap. Each cell plays one order or
 * gap of those two events and reads where the ink file is afterwards (the names it claims, or the trash) and what the
 * new name opens on, in the session and after a relaunch. Every cell wants the renamed PDF to open on its ink, and a
 * same-bytes copy that was in the vault before the rename, opened first where a cell has one, to open blank.
 *
 * Each cell logs one line, "ARM | <build> | <cell> | ...", before its one assert, so a red run still gives the row;
 * with HW_ARM_ROWS set to a file path, every row is appended there too, a passed cell's as well. A cell whose title
 * starts "known limit" is a road not fixed yet and is expected to fail; it still logs its row.
 *
 * Harness: the one in PdfRenameWaitsThenDelete.test.ts (the plugin's own vault handlers and opens, the real stores on an
 * in-memory vault, a relaunch is a new plugin session over the same vault), cut down, with a layout that can start
 * not ready. The same file runs on the published build and on the tip.
 */
import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(_message: string) {}
	},
}));

import HandwritingPlugin from "../main";
import { TFile, Notice } from "obsidian";
import pluginSettingsSource from "../settings/PluginSettings.ts?raw";
import manifestSource from "../../manifest.json?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { parsePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const INK = ".handwriting";
const OLD = "Old.pdf";
const NEW = "New.pdf";
/** The build under test, for the logged row. */
const BUILD = (JSON.parse(manifestSource) as { version: string }).version;
/** When set, every cell's row is appended to this file too. */
declare const process: { env: Record<string, string | undefined> };
const ROWS = process.env.HW_ARM_ROWS;

// Execute the production host registration, including its load options, rather than reconstructing that adapter here.
const source = pluginSettingsSource.replace(/\r\n/g, "\n");
const hostStart = "\t\tthis.pdfStore.attachHost({";
expect(source.split(hostStart)).toHaveLength(2);
const hostAt = source.indexOf(hostStart);
const hostEnd = source.indexOf("\n\t\t});", hostAt);
expect(hostEnd).toBeGreaterThan(hostAt);
const installPdfHost = new Function("Notice", "blockNotice", source.slice(hostAt, hostEnd + "\n\t\t});".length));

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

/** The bytes of one document. Another `tag` is another document. */
function doc(tag: string): Uint8Array {
	return new TextEncoder().encode(`%PDF-1.4\n% ${tag}\n1 0 obj << /Type /Catalog >> endobj\n` + "x".repeat(5000) + "\n%%EOF\n");
}

type RetireSpy = { mock: { results: { value: unknown }[] } };
let retirements: RetireSpy;

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	retirements = vi.spyOn(PdfInkStore.prototype as never as { retireDeletedPath(...a: unknown[]): Promise<void> }, "retireDeletedPath");
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

type Vault = ReturnType<typeof vault>;

/** One vault: the ink folder, the PDF list with each file's bytes, and local storage. */
function vault() {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	const inFolder = (folder: string) =>
		[...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/"));
	adapter.list = async (folder: string) => {
		const files = inFolder(folder);
		// The host reads the folder first: one that is not there rejects at the read.
		if (files.length === 0 && !adapter.dirs.has(folder)) {
			throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${folder}'`), { code: "ENOENT" });
		}
		return { files, folders: [] };
	};
	// A folder is there while it holds a file, as on disk.
	const exists = adapter.exists.bind(adapter);
	adapter.exists = async (p: string) => (await exists(p)) || inFolder(p).length > 0;
	const files = new Map<string, Uint8Array>();
	/** A file's creation stamp, when a cell sets one; 0 otherwise. */
	const ctimes = new Map<string, number>();
	const local = new Map<string, unknown>();
	/** Every ink file that holds `stroke`: live ones by the names they claim, and how many sit in the trash. */
	function inkPlace(strokeId: string, inked: string): string {
		const parts: string[] = [];
		let trashed = 0;
		for (const [p, bytes] of adapter.files) {
			if (!p.startsWith(INK + "/") || !p.endsWith(".json")) continue;
			const rest = p.slice(INK.length + 1);
			const data = parsePage(bytes, rest).data;
			if (!data.strokes.some((s) => s.id === strokeId)) continue;
			if (rest.startsWith("trash/")) trashed++;
			else if (!rest.includes("/")) {
				const claims = [...(data.pdfPaths ?? [])].sort().join(" + ") || "no name";
				parts.push(rest === `${inked}.json` ? `claims ${claims}` : `another file claims ${claims}`);
			}
		}
		if (trashed > 0) parts.push(trashed === 1 ? "trash" : `trash x${trashed}`);
		return parts.join(", ") || "gone";
	}
	/** A file's stat as the vault gives it. */
	const stat = (path: string) => ({ size: files.get(path)?.length ?? 0, mtime: 1, ctime: ctimes.get(path) ?? 0 });
	return { adapter, files, ctimes, stat, local, inkPlace };
}

function pdfFile(v: Vault, path: string) {
	return Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		name: path.split("/").pop(),
		basename: path.replace(/\.[^.]+$/, ""),
		stat: v.stat(path),
	});
}

/** A plugin session (fresh memory) over the vault, with the plugin's own vault events. `ready`: the layout is ready at load. */
function session(v: Vault, ready = true) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	const layout = { ready, waiting: [] as (() => void)[] };
	const workspace = {
		get layoutReady() {
			return layout.ready;
		},
		onLayoutReady: (f: () => void) => {
			if (layout.ready) f();
			else layout.waiting.push(f);
		},
	};
	// As main.ts builds it: the deletions restored at load start their grace once the layout is ready.
	const pdfStore = new PdfInkStore({ afterLayout: (start) => workspace.onLayoutReady(start) });
	const vaultOn = new Map<string, ((...a: unknown[]) => unknown)[]>();
	/** Paths whose PDF bytes cannot be read for now: every read throws (readFails, readWorks). */
	const unreadable = new Set<string>();
	const app = {
		vault: {
			adapter: v.adapter,
			getFiles: () => [...v.files.keys()].map((path) => ({ path, extension: "pdf", stat: v.stat(path) })),
			readBinary: async (file: { path: string }) => {
				if (unreadable.has(file.path)) throw new Error(`could not read ${file.path}`);
				const bytes = v.files.get(file.path);
				if (!bytes) throw new Error(`no file at ${file.path}`);
				return bytes.slice().buffer;
			},
			getFileByPath: (p: string) => (v.files.has(p) ? { path: p, extension: "pdf", stat: v.stat(p) } : null),
			on: (name: string, handler: (...a: unknown[]) => unknown) => {
				vaultOn.set(name, [...(vaultOn.get(name) ?? []), handler]);
				return {};
			},
		},
		workspace,
		loadLocalStorage: (key: string) => v.local.get(key) ?? null,
		saveLocalStorage: (key: string, value: unknown) => {
			if (value === null) v.local.delete(key);
			else v.local.set(key, value);
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
		registerEvent: () => {},
		register: () => {},
	});
	installPdfHost.call(plugin, Notice, (m: string) => new Notice(m));
	plugin.onloadVaultEvents();
	// The deletions still in their grace are saved where the next launch finds them, as at onload.
	plugin.attachPdfPendingDeletes();
	// As onloadFlushAndForeground: the vault's PDFs are listed into this device's record once the layout is ready.
	workspace.onLayoutReady(() => plugin.notePdfPathsListed());
	async function open(path: string) {
		expect(v.files.has(path), `precondition: ${path} exists in the vault`).toBe(true);
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, idle: true };
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		let failed = false;
		await plugin.resolvePdfId({ view: { file: { path } } }, root, controller).catch(() => {
			failed = true;
		});
		await store.flush();
		return { root, id: plugin.pdfIds.get(root) as string | undefined, failed };
	}
	function close(root: HTMLElement) {
		(root as unknown as { isConnected: boolean }).isConnected = false;
		plugin.pdfInk.delete(root);
		plugin.pdfIds.delete(root);
		plugin.pdfFiles.delete(root);
	}
	function draw(id: string, s: InkStroke) {
		pdfStore.replaceAll(id, [...pdfStore.strokes(id), s]);
	}
	/** The PDF list loses the file, then every delete handler the plugin registered runs. */
	async function deleteFile(path: string) {
		v.files.delete(path);
		for (const handler of vaultOn.get("delete") ?? []) await handler(pdfFile(v, path));
	}
	/** The PDF list gains the file with these bytes, then every create handler the plugin registered runs. */
	async function createFile(path: string, bytes: Uint8Array) {
		v.files.set(path, bytes);
		for (const handler of vaultOn.get("create") ?? []) await handler(pdfFile(v, path));
	}
	/** The app loads the vault before its layout is ready: it reports every PDF there as created. */
	async function vaultLoads() {
		for (const path of [...v.files.keys()]) for (const handler of vaultOn.get("create") ?? []) await handler(pdfFile(v, path));
	}
	/** The app's layout becomes ready: every callback waiting for it runs. */
	function layoutReady() {
		layout.ready = true;
		for (const f of layout.waiting.splice(0)) f();
	}
	/** The plugin unloads (Obsidian quits): its deletions' timers stop, their saved list stays. */
	function quit() {
		pdfStore.cancelPendingDeletes();
	}
	/** Open `path`, read the ink it shows, close it. */
	async function inkAt(path: string): Promise<{ strokes: string[]; failed: boolean }> {
		const o = await open(path);
		const strokes = o.id === undefined ? [] : pdfStore.strokes(o.id).map((x) => x.id);
		close(o.root);
		return { strokes, failed: o.failed };
	}
	return {
		store,
		pdfStore,
		open,
		close,
		draw,
		deleteFile,
		createFile,
		vaultLoads,
		layoutReady,
		quit,
		inkAt,
		readFails: (path: string) => unreadable.add(path),
		readWorks: (path: string) => unreadable.delete(path),
	};
}

type Session = ReturnType<typeof session>;

/**
 * Old.pdf opened in its own session, one stroke drawn and saved, closed: what the sync finds. `also` are in the vault
 * through that session too, so this device saw them. Returns the ink id.
 */
async function inkedOld(v: Vault, also: readonly string[] = []): Promise<string> {
	v.files.set(OLD, doc("notes"));
	for (const path of also) v.files.set(path, doc("notes"));
	const s = session(v);
	const o = await s.open(OLD);
	expect(o.id, `precondition: ${OLD} opened on an ink id`).toBeDefined();
	s.draw(o.id!, stroke(10, "ink-0"));
	await s.store.flush();
	s.close(o.root);
	expect(v.inkPlace("ink-0", o.id!), "precondition: the ink file claims the old name").toBe(`claims ${OLD}`);
	return o.id!;
}

/**
 * The clock runs `ms` on; every retirement it started is waited for to its end (each reads the PDF heads with the
 * real digest, off the fake clock), and the store is flushed.
 */
async function clock(s: Session, ms: number) {
	const seen = retirements.mock.results.length;
	await vi.advanceTimersByTimeAsync(ms);
	for (let i = 0; i < 10; i++) {
		const n = retirements.mock.results.length;
		await Promise.allSettled(retirements.mock.results.slice(seen).map((r) => r.value as Promise<void>));
		await vi.advanceTimersByTimeAsync(0);
		await s.store.flush();
		if (retirements.mock.results.length === n) break;
	}
}

const COPY = "Copy.pdf";

type Opened = { strokes: string[]; failed: boolean };
const shows = (o: Opened) => (o.failed ? "open failed" : o.strokes.length ? `ink [${o.strokes.join(",")}]` : "blank");

/** Open the copy first when asked, then the new name when it is there; each closed again. What each showed. */
async function opens(v: Vault, s: Session, copy: boolean): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	if (copy) out[COPY] = shows(await s.inkAt(COPY));
	if (v.files.has(NEW)) out[NEW] = shows(await s.inkAt(NEW));
	await s.store.flush();
	return out;
}

/**
 * The cell's end: where the ink file is with every timer run (`before`, no pane opened since the sync), then the
 * files opened here and after a relaunch, a same-bytes copy that was there before first when `copy`, then where the
 * ink file is after those opens. Wanted: the copy blank, the new name on the ink. One row logged, one assert.
 */
async function arm(v: Vault, s: Session, inked: string, cell: string, opts: { copy?: boolean; mid?: string } = {}) {
	const copy = opts.copy === true;
	const before = v.inkPlace("ink-0", inked);
	vi.useRealTimers();
	const here = await opens(v, s, copy);
	const relaunch = await opens(v, session(v), copy);
	const after = v.inkPlace("ink-0", inked);
	const want: Record<string, string> = {};
	if (copy) want[COPY] = "blank";
	if (v.files.has(NEW)) want[NEW] = "ink [ink-0]";
	const line = (o: Record<string, string>) => Object.entries(o).map(([k, x]) => `${k} ${x}`).join(", ");
	const row = `ARM | ${BUILD} | ${cell} | ink file${opts.mid ? ` ${opts.mid};` : ""} before open: ${before}; after open: ${after} | here: ${line(here)} | relaunch: ${line(relaunch)}`;
	console.info(row);
	// The reporter prints a passed cell's console to no one: the rows file keeps every cell's row.
	if (ROWS) appendFileSync(ROWS, row + "\n");
	expect(
		{ here, relaunch },
		`${cell}: the renamed PDF does not open on its ink, or the copy there before takes it, here or after a relaunch (ink file before open: ${before}; after: ${after})`
	).toEqual({ here: want, relaunch: want });
}

describe("a PDF renamed on another device, synced in as a delete and then a create", () => {
	for (const gap of [5_000, 15_000, 60_000]) {
		// Past the grace the ink is in the trash before the create: a known limit until the wait for a late create is set.
		const cell = gap > 10_000 ? it.fails : it;
		const known = gap > 10_000 ? "known limit, a create after the grace: " : "";
		cell(`${known}delete, then create ${gap / 1000} s later: the new name opens on the ink`, async () => {
			const v = vault();
			const inked = await inkedOld(v);
			const s = session(v);
			vi.useFakeTimers();
			await s.deleteFile(OLD);
			await clock(s, gap);
			await s.createFile(NEW, doc("notes"));
			await clock(s, 60_000);
			await arm(v, s, inked, `delete then create ${gap / 1000} s`);
		});
	}

	it("create, then delete 1 s later, the layout ready: the new name opens on the ink", async () => {
		const v = vault();
		const inked = await inkedOld(v);
		const s = session(v);
		vi.useFakeTimers();
		await s.createFile(NEW, doc("notes"));
		await clock(s, 1_000);
		await s.deleteFile(OLD);
		await clock(s, 60_000);
		await arm(v, s, inked, "create then delete 1 s, ready");
	});

	// A sync tool that sends the new name first and holds the old name's removal back, up to a minute: the delete
	// lands well after the create, still inside the create's 90 s mark.
	for (const gap of [11_000, 60_000]) {
		it(`create, then delete ${gap / 1000} s later, the layout ready: the new name opens on the ink`, async () => {
			const v = vault();
			const inked = await inkedOld(v);
			const s = session(v);
			vi.useFakeTimers();
			await s.createFile(NEW, doc("notes"));
			await clock(s, gap);
			await s.deleteFile(OLD);
			await clock(s, 60_000);
			await arm(v, s, inked, `create then delete ${gap / 1000} s, ready`);
		});
	}
});

describe("the same, with a same-bytes copy in the vault since before the delete, never opened, opened first", () => {
	it("no create: the copy opens blank", async () => {
		const v = vault();
		const inked = await inkedOld(v);
		v.files.set(COPY, doc("notes"));
		const s = session(v);
		vi.useFakeTimers();
		await s.deleteFile(OLD);
		await clock(s, 60_000);
		await arm(v, s, inked, "copy there, delete only", { copy: true });
	});

	for (const gap of [15_000, 60_000]) {
		it.fails(`known limit, a create after the grace: delete, then create ${gap / 1000} s later: the copy opens blank and the new name on the ink`, async () => {
			const v = vault();
			const inked = await inkedOld(v);
			v.files.set(COPY, doc("notes"));
			const s = session(v);
			vi.useFakeTimers();
			await s.deleteFile(OLD);
			await clock(s, gap);
			await s.createFile(NEW, doc("notes"));
			await clock(s, 60_000);
			await arm(v, s, inked, `copy there, delete then create ${gap / 1000} s`, { copy: true });
		});
	}

	it.fails("known limit, a create after the grace: delete, its grace over, the app quit, the create landed while closed: the copy opens blank and the new name on the ink", async () => {
		const v = vault();
		const inked = await inkedOld(v);
		v.files.set(COPY, doc("notes"));
		const first = session(v);
		vi.useFakeTimers();
		await first.deleteFile(OLD);
		await clock(first, 15_000);
		first.quit();
		v.files.set(NEW, doc("notes"));
		const s = session(v, false);
		await s.vaultLoads();
		await clock(s, 2_000);
		s.layoutReady();
		await clock(s, 60_000);
		await arm(v, s, inked, "copy there, delete, restart, create while closed", { copy: true });
	});
});

describe("the same, both events heard while the app starts, before its layout is ready", () => {
	it("create, then delete 1 s later, the layout ready 2 s after: the new name opens on the ink", async () => {
		const v = vault();
		const inked = await inkedOld(v);
		const s = session(v, false);
		vi.useFakeTimers();
		await s.vaultLoads();
		await s.createFile(NEW, doc("notes"));
		await clock(s, 1_000);
		await s.deleteFile(OLD);
		await clock(s, 2_000);
		s.layoutReady();
		await clock(s, 60_000);
		await arm(v, s, inked, "create then delete 1 s, before ready");
	});

	it("delete, then create 1 s later, the layout ready 2 s after: the new name opens on the ink", async () => {
		const v = vault();
		const inked = await inkedOld(v);
		const s = session(v, false);
		vi.useFakeTimers();
		await s.vaultLoads();
		await s.deleteFile(OLD);
		await clock(s, 1_000);
		await s.createFile(NEW, doc("notes"));
		await clock(s, 2_000);
		s.layoutReady();
		await clock(s, 60_000);
		await arm(v, s, inked, "delete then create 1 s, before ready");
	});

	// A copy this device saw before the launch: Copy.pdf is in the vault through the session that inked Old.pdf.
	for (const stampNow of [false, true]) {
		it(`a same-bytes copy this device saw before the launch${stampNow ? ", its creation stamp set to the launch" : ""}, the old name deleted 5 s after the layout is ready, no create: the copy opens blank`, async () => {
			const v = vault();
			const inked = await inkedOld(v, [COPY]);
			const s = session(v, false);
			vi.useFakeTimers();
			if (stampNow) v.ctimes.set(COPY, Date.now());
			await s.vaultLoads();
			await clock(s, 2_000);
			s.layoutReady();
			await clock(s, 5_000);
			await s.deleteFile(OLD);
			await clock(s, 60_000);
			await arm(v, s, inked, `copy seen before launch${stampNow ? ", stamp now" : ""}, delete 5 s after ready`, { copy: true });
		});
	}
});

describe("the rename landed while the app was closed", () => {
	it("both events while closed: at the next launch the old name is gone and the new one is there; the new name opens on the ink", async () => {
		const v = vault();
		const inked = await inkedOld(v);
		v.files.delete(OLD);
		v.files.set(NEW, doc("notes"));
		const s = session(v, false);
		vi.useFakeTimers();
		await s.vaultLoads();
		await clock(s, 2_000);
		s.layoutReady();
		await clock(s, 60_000);
		await arm(v, s, inked, "both while closed");
	});

	// The first file of the family opened takes ink whose every claimed path is gone, a copy there before too.
	it.fails("known limit, an older same-bytes copy opened first after a rename while closed: both events while closed, a same-bytes copy there since before, opened first: the copy opens blank and the new name on the ink", async () => {
		const v = vault();
		const inked = await inkedOld(v);
		v.files.set(COPY, doc("notes"));
		v.files.delete(OLD);
		v.files.set(NEW, doc("notes"));
		const s = session(v, false);
		vi.useFakeTimers();
		await s.vaultLoads();
		await clock(s, 2_000);
		s.layoutReady();
		await clock(s, 60_000);
		await arm(v, s, inked, "copy there, both while closed", { copy: true });
	});

	it("the delete heard, the app quit 3 s into its grace, the create landed while closed: the new name opens on the ink", async () => {
		const v = vault();
		const inked = await inkedOld(v);
		const first = session(v);
		vi.useFakeTimers();
		await first.deleteFile(OLD);
		await clock(first, 3_000);
		first.quit();
		v.files.set(NEW, doc("notes"));
		const s = session(v, false);
		await s.vaultLoads();
		await clock(s, 2_000);
		s.layoutReady();
		await clock(s, 60_000);
		await arm(v, s, inked, "delete heard, quit in grace, create while closed");
	});
});

describe("the new file's bytes not readable yet when the grace ends (a sync placeholder)", () => {
	it("delete, then create 2 s later, its bytes readable 30 s after the create: the ink file is untouched while it waits, and the new name opens on the ink", async () => {
		const v = vault();
		const inked = await inkedOld(v);
		const ink = () => v.adapter.files.get(`${INK}/${inked}.json`);
		const saved = ink();
		const s = session(v);
		vi.useFakeTimers();
		const seen: string[] = [];
		let untouched = true;
		// Where the ink file is at `t` s after the delete; while the bytes cannot be read, also whether it is untouched.
		const look = (t: number, unreadable: boolean) => {
			if (unreadable) untouched &&= ink() === saved;
			seen.push(`at ${t} s: ${v.inkPlace("ink-0", inked)}`);
		};
		await s.deleteFile(OLD);
		await clock(s, 2_000);
		s.readFails(NEW);
		await s.createFile(NEW, doc("notes"));
		await clock(s, 8_000);
		look(10, true);
		await clock(s, 10_000);
		look(20, true);
		await clock(s, 11_900);
		look(32, true);
		s.readWorks(NEW);
		await clock(s, 8_100);
		look(40, false);
		await clock(s, 6 * 60_000);
		const mid = `${seen.join("; ")}; untouched while unreadable: ${untouched ? "yes" : "NO"}`;
		await arm(v, s, inked, "create 2 s, bytes readable 30 s later", { mid });
		expect(untouched, "the ink file was written or removed while the new file's bytes could not be read").toBe(true);
	});
});
