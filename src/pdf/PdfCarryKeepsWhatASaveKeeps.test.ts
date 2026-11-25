import { afterEach, beforeEach, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import type { InkStroke } from "../ink/Stroke";

// After a carry on either road, the new ink file holds every field a plain save of the old record writes, with the
// unknown entries of the objects they hold, except the per-file ones; placed strokes go by the ledger, pageless ones
// once; the new file's own value wins. Each cell is named for the break it guards (K1 to K8), a pin (P1 to P3), or
// the first finding (SWEEP).
//
// The want is never written out by hand: it is what the store itself writes for a plain save of the old file, read
// from a copy of the vault (plainSave). Synthetic storage only. Production identity, PDF store and PageStore execute.

const shown = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class Notice {
		constructor(message: string) {
			shown.push(message);
		}
	}
	return { ...actual, Notice };
});

const KEPT_NOTICE = "Handwriting: this PDF changed on disk. Ink drawn before the change is kept in its old ink file; new ink goes to a new one.";
const CARRIED_NOTICE = "Handwriting: this PDF changed on disk. Your ink was carried over to its new version.";
const changeNotices = () => shown.filter((m) => m.startsWith("Handwriting: this PDF changed on disk."));

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
	shown.length = 0;
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function stroke(id: string, page = 1): InkStroke {
	return {
		id, page, tool: "pen", color: "#111111", width: 2, createdAt: 0,
		points: [{ x: 10, y: 10, pressure: 0.5, t: 0 }, { x: 20, y: 20, pressure: 0.5, t: 8 }],
		bbox: { x: 10, y: 10, width: 10, height: 10 },
	};
}

function vault() {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	adapter.list = async (folder) => ({
		files: [...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")),
		folders: [],
	});
	const bytes = new TextEncoder().encode("%PDF-1.4\n" + "x".repeat(70000) + "\n%%EOF\n");
	return { adapter, pdfs: new Map([["Paper.pdf", bytes]]) };
}
type Vault = ReturnType<typeof vault>;

function session(v: Vault) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	const pdfStore = new PdfInkStore();
	pdfStore.attachHost({
		load: (id, options) => store.load(id, options),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => {},
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing, "pdf"),
		acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
	});
	const leaves: { view: { file: { path: string }; containerEl: HTMLElement } }[] = [];
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, {
		app: {
			workspace: { getLeavesOfType: (type: string) => type === "pdf" ? leaves : [] },
			vault: {
				adapter: v.adapter,
				readBinary: async (file: { path: string }) => v.pdfs.get(file.path)!.slice().buffer,
				getFileByPath: (path: string) => v.pdfs.has(path) ? { path, extension: "pdf" } : null,
			},
		},
		store, pdfStore, pdfInk: new Map(), pdfIds: new Map(), pdfFiles: new Map(),
	});
	async function open(path = "Paper.pdf") {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, forgetHistory() {}, idle: true };
		const leaf = { view: { file: { path }, containerEl: root } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId(leaf, root, controller);
		const id = plugin.pdfIds.get(root) as string;
		expect(id, "production resolution must bind a PDF identity").toMatch(/^pdf-[0-9a-f]+(?:-\d+)?$/);
		return { root, id, controller };
	}
	function close(root: HTMLElement) {
		leaves.splice(leaves.findIndex((l) => l.view.containerEl === root), 1);
		const was = plugin.pdfIds.get(root);
		plugin.pdfInk.delete(root);
		plugin.pdfIds.delete(root);
		plugin.pdfFiles.delete(root);
		if (was) plugin.releasePdfId(was);
	}
	return { store, pdfStore, plugin, open, close };
}

const ids = (strokes: readonly { id: string }[]) => strokes.map((s) => s.id);

function recordPasses(plugin: { onPdfModified: unknown }): Promise<void>[] {
	const passes: Promise<void>[] = [];
	const onPdfModified = plugin.onPdfModified as (...args: unknown[]) => Promise<void>;
	plugin.onPdfModified = function (this: unknown, ...args: unknown[]) {
		const pass = onPdfModified.apply(this, args);
		passes.push(pass);
		return pass;
	};
	return passes;
}

async function heldRetry(passes: Promise<void>[]): Promise<void> {
	const before = passes.length;
	await vi.advanceTimersByTimeAsync(1000);
	expect(passes.length, "the held pane's retry ran once").toBe(before + 1);
	await passes[passes.length - 1];
}

function disk(v: Vault, path: string) {
	const raw = v.adapter.files.get(path);
	expect(raw, `sidecar exists: ${path}`).toBeDefined();
	return JSON.parse(raw!);
}

function mutate(v: Vault) {
	const after = v.pdfs.get("Paper.pdf")!.slice();
	after[100] = 121;
	v.pdfs.set("Paper.pdf", after);
}

/** What the old file is given before the change: each a thing a plain save of it keeps. */
type Extra = "top" | "strokeKey" | "tool" | "pageless" | "twoPageless" | "onlyPageless" | "attachments" | "textBox" | "proto";
const ALL: readonly Extra[] = ["top", "strokeKey", "tool", "pageless", "attachments", "textBox"];

function own(o: object, key: string, value: unknown): void {
	Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
}

/** The old ink file as a later build could have written it: the session's own file with the named extras added. */
function seedText(text: string, extras: readonly Extra[]): string {
	const json = JSON.parse(text);
	const first = json.strokes[0];
	const clean = JSON.parse(JSON.stringify(first));
	const pageless = (id: string, color: string) => {
		const p = { ...clean, id, color, zzP: 2 };
		delete p.page;
		return p;
	};
	if (extras.includes("top")) json.zzTop = { kept: "top" };
	if (extras.includes("strokeKey")) first.zz = 1;
	if (extras.includes("tool")) first.tool = "future-tool";
	if (extras.includes("pageless")) json.strokes.push(pageless("pageless-1", "#222222"));
	// Two strokes under one file id, not equal: two strokes (PageMigrate names the second).
	if (extras.includes("twoPageless")) json.strokes.push(pageless("pageless-dup", "#333333"), pageless("pageless-dup", "#444444"));
	if (extras.includes("onlyPageless")) for (const s of json.strokes) delete s.page;
	if (extras.includes("attachments")) json.attachments = [{ v: 99, id: "att-1", future: [1, 2] }];
	if (extras.includes("textBox")) json.textBoxes = [{ id: "box-1", x: 5, y: 6, width: 100, z: 0, zzBox: 3 }];
	if (extras.includes("proto")) {
		own(json, "__proto__", { p: 1 });
		own(first, "__proto__", { q: 2 });
	}
	return JSON.stringify(json);
}

/** The bytes the store writes for a plain save of `id`'s file: read and saved unchanged, in a copy of the vault. */
async function plainSaveText(v: Vault, id: string): Promise<string> {
	const copy = vault();
	for (const [p, text] of v.adapter.files) copy.adapter.externalWrite(p, text);
	const s = session(copy);
	await s.pdfStore.ensureLoaded(id);
	expect(s.pdfStore.inkReady(id), "precondition: the old file reads sound").toBe(true);
	const before = copy.adapter.writeAttempts;
	s.pdfStore.save(id);
	await s.store.flush();
	expect(copy.adapter.writeAttempts, "precondition: the plain save wrote").toBeGreaterThan(before);
	return copy.adapter.files.get(s.store.path(id))!;
}

/** Every field but the ones each file holds for itself. */
const PER_FILE = ["schemaVersion", "pageId", "surface", "coordSpace", "pdfPaths", "strokes"];
function rest(o: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = Object.create(null);
	for (const k of Object.keys(o)) if (!PER_FILE.includes(k)) own(out, k, o[k]);
	return out;
}

/**
 * The change on each road. open: a pane shows the PDF, idle. released: the same, with the old record forgotten
 * before the new id lands (K1). closed: no pane shows it, same session (road 2). restart: changed while Obsidian
 * was closed (road 2, new session).
 */
type Road = "open" | "released" | "closed" | "restart";

async function carried(road: Road, extras: readonly Extra[], placed: readonly string[] = ["before-change"],
	before?: (s: ReturnType<typeof session>, oldId: string) => void) {
	const v = vault();
	const s = session(v);
	const opened = await s.open();
	for (const id of placed) s.pdfStore.commit(opened.id, stroke(id));
	await s.store.flush();
	const oldId = opened.id;
	const oldPath = s.store.path(oldId);
	if (road === "closed") {
		s.close(opened.root);
		await vi.advanceTimersByTimeAsync(5000);
	}
	v.adapter.externalWrite(oldPath, seedText(v.adapter.files.get(oldPath)!, extras));
	const oldBytes = v.adapter.files.get(oldPath)!;
	const plain = await plainSaveText(v, oldId);
	if (road === "open" || road === "released") {
		await s.pdfStore.reloadExternal(oldId);
		expect(s.pdfStore.inkReady(oldId), "precondition: the old record read the seeded file").toBe(true);
	}
	const generationBefore = s.pdfStore.generation(oldId);
	before?.(s, oldId);
	mutate(v);
	let c = s;
	let now: string;
	if (road === "open" || road === "released") {
		if (road === "released") {
			const read = s.plugin.app.vault.readBinary;
			s.plugin.app.vault.readBinary = async (file: { path: string }) => {
				await vi.advanceTimersByTimeAsync(5000);
				return read(file);
			};
		}
		await s.plugin.onPdfModified("Paper.pdf");
		if (road === "released") {
			expect(s.pdfStore.generation(oldId), "precondition: the release forgot the old record during the resolution").toBeNull();
		}
		now = s.plugin.pdfIds.get(opened.root) as string;
	} else if (road === "closed") {
		await s.plugin.onPdfModified("Paper.pdf");
		now = (await s.open()).id;
	} else {
		c = session(v);
		now = (await c.open()).id;
	}
	expect(now, "new bytes, new ink file").not.toBe(oldId);
	await c.store.flush();
	return { v, s: c, opened, oldId, oldPath, oldBytes, plain, now, newPath: c.store.path(now), generationBefore };
}

/** The new file holds every field the plain save of the old one writes, and the same strokes, in the same order. */
function holdsThePlainSave(r: Awaited<ReturnType<typeof carried>>) {
	const written = disk(r.v, r.newPath);
	const plain = JSON.parse(r.plain);
	expect(rest(written), "every field a plain save keeps, unknown ones included").toEqual(rest(plain));
	expect(written.strokes, "the strokes a plain save writes, pageless ones included, each as written").toEqual(plain.strokes);
	expect(r.v.adapter.files.get(r.oldPath), "the old ink file is never written").toBe(r.oldBytes);
}

for (const road of ["open", "closed", "restart"] as const) {
	it(`SWEEP-${road}: an unknown top key, a stroke's unknown key and a pageless stroke all reach the new ink file`, async () => {
		const r = await carried(road, ["top", "strokeKey", "pageless"]);
		const written = disk(r.v, r.newPath);
		expect(written.zzTop).toEqual({ kept: "top" });
		expect(written.strokes.find((s: { id: string }) => s.id === "before-change")?.zz).toBe(1);
		expect(ids(written.strokes)).toContain("pageless-1");
		holdsThePlainSave(r);
	});

	it(`K2-${road}: a pageless stroke goes to the file only, never to the page's strokes`, async () => {
		const r = await carried(road, ["pageless"]);
		expect(ids(disk(r.v, r.newPath).strokes)).toEqual(["pageless-1", "before-change"]);
		expect(ids(r.s.pdfStore.strokes(r.now)), "the session holds placed strokes only").toEqual(["before-change"]);
		expect(ids(r.s.pdfStore.strokesOnPage(r.now, 1))).toEqual(["before-change"]);
	});

	it(`K3-${road}: a carried stroke keeps a later build's tool and its unknown key, as the old file wrote them`, async () => {
		const r = await carried(road, ["tool", "strokeKey"]);
		const oldStroke = JSON.parse(r.oldBytes).strokes.find((s: { id: string }) => s.id === "before-change");
		const newStroke = disk(r.v, r.newPath).strokes.find((s: { id: string }) => s.id === "before-change");
		expect(oldStroke.tool, "precondition: the old file holds the later tool").toBe("future-tool");
		expect(newStroke).toEqual(oldStroke);
		holdsThePlainSave(r);
	});

	it(`K5-${road}: an attachments record this build cannot read and a text box with its unknown key reach the new file`, async () => {
		const r = await carried(road, ["attachments", "textBox"]);
		const written = disk(r.v, r.newPath);
		expect(written.attachments).toEqual([{ v: 99, id: "att-1", future: [1, 2] }]);
		expect(written.textBoxes).toEqual([{ id: "box-1", x: 5, y: 6, width: 100, z: 0, zzBox: 3 }]);
		holdsThePlainSave(r);
	});

	it(`K4-${road}: keys named __proto__ fare as a plain save makes them fare, and set no prototype`, async () => {
		const r = await carried(road, ["proto", "top", "strokeKey"]);
		const count = (text: string) => text.split('"__proto__"').length - 1;
		expect(count(r.v.adapter.files.get(r.newPath)!)).toBe(count(r.plain));
		expect(Object.getPrototypeOf(disk(r.v, r.newPath))).toBe(Object.prototype);
		expect(({} as Record<string, unknown>).p, "no prototype was polluted").toBeUndefined();
		expect(({} as Record<string, unknown>).q, "no prototype was polluted").toBeUndefined();
		holdsThePlainSave(r);
	});

	it(`P2-${road}: an old file with every extra is still carried, said once, and nothing says it was kept`, async () => {
		const r = await carried(road, ALL);
		expect(ids(r.s.pdfStore.strokesOnPage(r.now, 1))).toEqual(["before-change"]);
		expect(changeNotices()).toEqual([CARRIED_NOTICE]);
		expect(shown).not.toContain(KEPT_NOTICE);
		holdsThePlainSave(r);
	});

	it(`P3-${road}: an old file holding only pageless strokes gets no carry, no notice and no new file, a claim after included`, async () => {
		const r = await carried(road, ["onlyPageless", "top"]);
		expect(ids(r.s.pdfStore.strokes(r.now))).toEqual([]);
		expect(changeNotices()).toEqual([]);
		expect(r.v.adapter.files.has(r.newPath), "no new ink file").toBe(false);
		r.s.pdfStore.claimPath(r.now, "Other.pdf");
		await r.s.store.flush();
		expect(r.v.adapter.files.has(r.newPath), "a claim on the id writes nothing either (K7)").toBe(false);
		expect(r.v.adapter.files.get(r.oldPath)).toBe(r.oldBytes);
	});
}

for (const road of ["open", "released", "closed", "restart"] as const) {
	it(`P1-${road}: an old file holding only placed strokes and per-file fields gives today's bytes`, async () => {
		const r = await carried(road, [], ["before-change", "second"]);
		const plain = JSON.parse(r.plain);
		expect(Object.keys(plain), "precondition: per-file fields and empty lists only").toEqual(
			["schemaVersion", "pageId", "surface", "coordSpace", "pdfPaths", "textBoxes", "images", "strokes"]);
		expect(r.v.adapter.files.get(r.newPath)).toBe(JSON.stringify({ ...plain, pageId: r.now }));
		expect(changeNotices()).toEqual([CARRIED_NOTICE]);
	});
}

it("K1-released: what is carried beside the strokes is read with them, before the old record is let go", async () => {
	const r = await carried("released", ALL);
	expect(ids(r.s.pdfStore.strokesOnPage(r.now, 1))).toEqual(["before-change"]);
	holdsThePlainSave(r);
});

it("K8: the carry leaves the old record as it was, in memory too, so its release still lets it go", async () => {
	// The release reads the old record's generation when it is called (PdfClaims releasePdfId) and forgets the record
	// later only if it still has that one; by the end the record is gone, so the generation is read at that call.
	const atRelease: (number | null)[] = [];
	const r = await carried("open", ALL, ["before-change"], (s, oldId) => {
		const release = s.plugin.releasePdfId as (id: string) => void;
		s.plugin.releasePdfId = function (this: unknown, id: string) {
			if (id === oldId) atRelease.push(s.pdfStore.generation(id));
			return release.call(this, id);
		};
	});
	expect(atRelease.length, "precondition: the change released the old id").toBeGreaterThan(0);
	for (const g of atRelease) expect(g, "the old record's generation when its release reads it").toBe(r.generationBefore);
	await vi.advanceTimersByTimeAsync(5000);
	await r.s.store.flush();
	expect(r.s.pdfStore.generation(r.oldId), "the old record is released").toBeNull();
	expect(r.v.adapter.files.get(r.oldPath)).toBe(r.oldBytes);
});

/** Two panes on the file, the second busy during the change; the first carries, the second carries again on its retry. */
async function heldTwice(extras: readonly Extra[], between: (s: ReturnType<typeof session>, now: string, oldId: string) => void) {
	const v = vault();
	const s = session(v);
	const first = await s.open();
	const second = await s.open();
	const passes = recordPasses(s.plugin);
	s.pdfStore.commit(first.id, stroke("before-change"));
	await s.store.flush();
	const oldPath = s.store.path(first.id);
	v.adapter.externalWrite(oldPath, seedText(v.adapter.files.get(oldPath)!, extras));
	const oldBytes = v.adapter.files.get(oldPath)!;
	const plain = await plainSaveText(v, first.id);
	await s.pdfStore.reloadExternal(first.id);
	second.controller.idle = false;
	mutate(v);
	await s.plugin.onPdfModified("Paper.pdf");
	const now = s.plugin.pdfIds.get(first.root) as string;
	expect(now).not.toBe(first.id);
	expect(s.plugin.pdfIds.get(second.root), "the busy pane is left on the old id").toBe(first.id);
	await s.store.flush();
	between(s, now, first.id);
	await s.store.flush();
	const writes = v.adapter.writeAttempts;
	await vi.advanceTimersByTimeAsync(1000);
	second.controller.idle = true;
	await heldRetry(passes);
	expect(s.plugin.pdfIds.get(second.root), "the busy pane moved once it went idle").toBe(now);
	await s.store.flush();
	return { v, s, now, oldPath, oldBytes, plain, newPath: s.store.path(now), writesBefore: writes };
}

it("K6-held: a second carry from the same old file adds its new stroke and no second copy of anything", async () => {
	const r = await heldTwice(["top", "strokeKey", "pageless", "twoPageless"], (s, _now, oldId) => {
		s.pdfStore.commit(oldId, stroke("during"));
	});
	expect(ids(r.s.pdfStore.strokesOnPage(r.now, 1))).toEqual(["before-change", "during"]);
	const written = disk(r.v, r.newPath);
	expect(ids(written.strokes)).toEqual(["pageless-1", "pageless-dup", "pageless-dup-2", "before-change", "during"]);
	expect(written.zzTop).toEqual({ kept: "top" });
	// The old file is written here, by the busy pane's own stroke on the old id (as before this rule), not by a carry.
});

it("K6-erase: a carried stroke erased in the new file stays gone, with its entry, when the busy pane catches up", async () => {
	const r = await heldTwice(["strokeKey", "pageless"], (s, now, oldId) => {
		s.pdfStore.replaceAll(now, []);
		s.pdfStore.commit(oldId, stroke("during"));
	});
	expect(ids(r.s.pdfStore.strokesOnPage(r.now, 1))).toEqual(["during"]);
	const written = disk(r.v, r.newPath);
	expect(ids(written.strokes)).toEqual(["pageless-1", "during"]);
	expect(written.strokes.some((s: { zz?: number }) => s.zz !== undefined), "the erased stroke's entry is not written").toBe(false);
});

it("K7-nothing-added: a second carry that adds no placed stroke writes nothing", async () => {
	const r = await heldTwice(["top", "pageless"], (s, now) => {
		s.pdfStore.replaceAll(now, []);
	});
	expect(ids(r.s.pdfStore.strokes(r.now))).toEqual([]);
	expect(r.v.adapter.writeAttempts, "no write after the second carry").toBe(r.writesBefore);
});

it("K6-two-idle: two idle panes carry in one pass and the new file holds one copy of each extra", async () => {
	const v = vault();
	const s = session(v);
	const first = await s.open();
	const second = await s.open();
	s.pdfStore.commit(first.id, stroke("before-change"));
	await s.store.flush();
	const oldPath = s.store.path(first.id);
	v.adapter.externalWrite(oldPath, seedText(v.adapter.files.get(oldPath)!, ["top", "pageless", "textBox"]));
	const plain = JSON.parse(await plainSaveText(v, first.id));
	await s.pdfStore.reloadExternal(first.id);
	mutate(v);
	await s.plugin.onPdfModified("Paper.pdf");
	const now = s.plugin.pdfIds.get(first.root) as string;
	expect(s.plugin.pdfIds.get(second.root)).toBe(now);
	await s.store.flush();
	const written = disk(v, s.store.path(now));
	expect(rest(written)).toEqual(rest(plain));
	expect(written.strokes).toEqual(plain.strokes);
	expect(changeNotices()).toEqual([CARRIED_NOTICE]);
});

it("K6-own-values: a new ink file with its own unknown key and pageless stroke keeps them; the old file's are added once", async () => {
	const v = vault();
	// The new bytes' id, found on a scratch vault: identity is the bytes' digest.
	const scratch = vault();
	mutate(scratch);
	const target = await session(scratch).open();
	const s = session(v);
	const opened = await s.open();
	s.pdfStore.commit(opened.id, stroke("v1-ink"));
	await s.store.flush();
	const oldPath = s.store.path(opened.id);
	v.adapter.externalWrite(oldPath, seedText(v.adapter.files.get(oldPath)!, ["top", "pageless"]));
	await s.pdfStore.reloadExternal(opened.id);
	const newPath = s.store.path(target.id);
	const ownPageless = { id: "pageless-own", tool: "pen", color: "#555555", width: 2, createdAt: 0, pts: [10, 10, 0.5, 0, 20, 20, 0.5, 8] };
	v.adapter.externalWrite(newPath, JSON.stringify({
		schemaVersion: 1, pageId: target.id, surface: "pdf", coordSpace: "page-css@1", pdfPaths: ["Paper.pdf"],
		zzTop: "the new file's own", textBoxes: [], images: [], strokes: [ownPageless],
	}));
	mutate(v);
	await s.plugin.onPdfModified("Paper.pdf");
	const now = s.plugin.pdfIds.get(opened.root) as string;
	expect(now, "precondition: the change binds the id whose file holds only its own extras").toBe(target.id);
	await s.store.flush();
	const written = disk(v, newPath);
	expect(written.zzTop, "the new file's own value wins").toBe("the new file's own");
	expect(ids(written.strokes)).toEqual(["pageless-own", "pageless-1", "v1-ink"]);
	expect(changeNotices()).toEqual([CARRIED_NOTICE]);
});

it("K7-read-in-flight: road 2 never writes the carried strokes without what is carried beside them", async () => {
	const v = vault();
	const s = session(v);
	const opened = await s.open();
	s.pdfStore.commit(opened.id, stroke("before-change"));
	await s.store.flush();
	const oldPath = s.store.path(opened.id);
	s.close(opened.root);
	await vi.advanceTimersByTimeAsync(5000);
	v.adapter.externalWrite(oldPath, seedText(v.adapter.files.get(oldPath)!, ["top", "pageless"]));
	const oldBytes = v.adapter.files.get(oldPath)!;
	mutate(v);
	// While road 2 lists the ink folders, a read of the new id starts (a poll after another device wrote it) and is
	// held until the open has finished. It then lands with the file that device wrote: no stroke and none of the old
	// file's extras, so a read that lands after a carry replaces what was carried beside the strokes.
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const load = s.store.load.bind(s.store);
	let now = "";
	vi.spyOn(s.store, "load").mockImplementation(async (id: string, options?: { restore?: boolean }) => {
		if (id === now) await gate;
		return load(id, options);
	});
	const listIds = s.store.listIds.bind(s.store);
	vi.spyOn(s.store, "listIds").mockImplementation(async (prefix: string) => {
		const shownIds = [...s.plugin.pdfIds.values()] as string[];
		if (now === "" && shownIds.length === 1) {
			now = shownIds[0]!;
			void s.pdfStore.reloadExternal(now);
		}
		return listIds(prefix);
	});
	const reopened = await s.open();
	expect(reopened.id).toBe(now);
	const newPath = s.store.path(now);
	expect(v.adapter.files.has(newPath), "precondition: no file for the new id before the other device's").toBe(false);
	v.adapter.externalWrite(newPath, JSON.stringify({
		schemaVersion: 1, pageId: now, surface: "pdf", coordSpace: "page-css@1", pdfPaths: ["Paper.pdf"], strokes: [],
	}));
	release();
	await vi.advanceTimersByTimeAsync(0);
	await s.store.flush();
	const carriedHere = ids(s.pdfStore.strokes(now)).includes("before-change");
	const written = disk(v, newPath);
	if (carriedHere || ids(written.strokes).includes("before-change")) {
		expect(written.zzTop, "carried strokes come with what is carried beside them").toEqual({ kept: "top" });
		expect(ids(written.strokes)).toContain("pageless-1");
	} else {
		expect(changeNotices(), "no carry, nothing said").toEqual([]);
		expect(written.zzTop, "the other device's file is not written over").toBeUndefined();
	}
	expect(v.adapter.files.get(oldPath), "the old ink file is never written").toBe(oldBytes);
});

it("K7-placed-only: road 2 with a read of the new id in flight still carries an old file that holds only placed strokes", async () => {
	const v = vault();
	const s = session(v);
	const opened = await s.open();
	s.pdfStore.commit(opened.id, stroke("before-change"));
	await s.store.flush();
	const oldPath = s.store.path(opened.id);
	s.close(opened.root);
	await vi.advanceTimersByTimeAsync(5000);
	// The old file as the session wrote it: placed strokes and the per-file fields, nothing else (every PDF ink file today).
	const oldBytes = v.adapter.files.get(oldPath)!;
	const oldFile = JSON.parse(oldBytes);
	expect(Object.values(rest(oldFile)).every((x) => Array.isArray(x) && x.length === 0), "precondition: beside the per-file fields, only empty lists").toBe(true);
	expect(oldFile.strokes.every((x: { page?: unknown }) => typeof x.page === "number"), "precondition: every stroke placed").toBe(true);
	mutate(v);
	// The K7-read-in-flight race: a read of the new id starts while road 2 lists the ink folders, and lands after the
	// open with the file another device wrote, which holds no stroke.
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const load = s.store.load.bind(s.store);
	let now = "";
	vi.spyOn(s.store, "load").mockImplementation(async (id: string, options?: { restore?: boolean }) => {
		if (id === now) await gate;
		return load(id, options);
	});
	const listIds = s.store.listIds.bind(s.store);
	vi.spyOn(s.store, "listIds").mockImplementation(async (prefix: string) => {
		const shownIds = [...s.plugin.pdfIds.values()] as string[];
		if (now === "" && shownIds.length === 1) {
			now = shownIds[0]!;
			void s.pdfStore.reloadExternal(now);
		}
		return listIds(prefix);
	});
	const readyAtCarry: boolean[] = [];
	const carryInto = s.pdfStore.carryInto.bind(s.pdfStore);
	vi.spyOn(s.pdfStore, "carryInto").mockImplementation((id: string, added: readonly InkStroke[], from) => {
		readyAtCarry.push(s.pdfStore.inkReady(id));
		return carryInto(id, added, from);
	});
	const reopened = await s.open();
	expect(reopened.id).toBe(now);
	expect(readyAtCarry, "precondition: road 2 carried once, while the new id's read was out").toEqual([false]);
	const newPath = s.store.path(now);
	v.adapter.externalWrite(newPath, JSON.stringify({
		schemaVersion: 1, pageId: now, surface: "pdf", coordSpace: "page-css@1", pdfPaths: ["Paper.pdf"], strokes: [],
	}));
	release();
	await vi.advanceTimersByTimeAsync(0);
	await s.store.flush();
	expect.soft(ids(s.pdfStore.strokes(now)), "the PDF shows the ink drawn before the change").toEqual(["before-change"]);
	expect.soft(ids(disk(v, newPath).strokes), "the new ink file holds it").toEqual(["before-change"]);
	expect.soft(changeNotices(), "said once, the carry's own notice").toEqual([CARRIED_NOTICE]);
	s.close(reopened.root);
	await vi.advanceTimersByTimeAsync(5000);
	await s.store.flush();
	const again = await s.open();
	expect.soft(ids(s.pdfStore.strokes(again.id)), "shown again at the next open").toEqual(["before-change"]);
	const restarted = session(v);
	const third = await restarted.open();
	await restarted.store.flush();
	expect.soft(ids(restarted.pdfStore.strokes(third.id)), "shown after a restart").toEqual(["before-change"]);
	expect.soft(changeNotices(), "nothing more said").toEqual([CARRIED_NOTICE]);
	expect(v.adapter.files.get(oldPath), "the old ink file is never written").toBe(oldBytes);
});
