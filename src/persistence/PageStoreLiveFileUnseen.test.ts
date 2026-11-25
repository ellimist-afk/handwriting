/**
 * A live ink file the host could not look at. Obsidian's adapters answer `exists` false on any error, so a load that
 * could not look at a page's live ink file took it for missing. A background flush's carrier was then written over it,
 * or an older generation from the ink trash was renamed over it, and the newest ink was gone. On desktop `exists` and
 * `stat` both meet the file; on mobile `exists` is itself a stat. One fault fails both looks together.
 *
 * Wanted: a load that could not look leaves the live file's bytes, the carrier and the trash as they are. It serves no
 * blank page and marks nothing missing: it ends as a read that threw does, for that page only, and the poll reloads it
 * until the look works. A page with no ink file still loads blank, also where the host's not-found error has no code. A
 * page whose file is seen makes today's calls, no more.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore, contentStamp } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageData, emptyPage } from "../model/PageData";

const F = ".handwriting";
const X = "x1";
const Y = "y1";
const PDF = "pdf-9f2c41d07a5e6b38";

function pageOf(id: string, ...labels: string[]): PageData {
	const p = emptyPage(id);
	p.surface = id.startsWith("pdf-") ? "pdf" : "inline";
	p.strokes = labels.map((label) => ({
		id: label,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 0 },
		createdAt: 0,
	}));
	return p;
}

/**
 * How the look at one file goes.
 * - "unseen": the host could not look. `exists` is false and `stat` rejects EACCES; `read` returns the bytes, or
 *   rejects EACCES when `readFails` is set.
 * - "access-only": `exists` is false while `stat` and `read` work (a file the process may open but not list).
 * - "codeless-missing": there is no file, and `stat` rejects a not-found error with no code, as mobile does when the
 *   message does not say "does not exist".
 * - "stat-eio": `exists` is true, `stat` rejects EIO, `read` works.
 */
type Fault = "unseen" | "access-only" | "codeless-missing" | "stat-eio";

/** The in-memory vault, with a trash listing as the desktop host gives it and looks that fail as the host's do. */
function disk() {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	const calls = { stat: [] as string[], read: [] as string[], list: [] as string[] };
	const faults = new Map<string, { kind: Fault; readFails: boolean }>();
	const inFolder = (folder: string) =>
		[...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/"));
	adapter.list = async (folder: string) => {
		calls.list.push(folder);
		const files = inFolder(folder);
		if (files.length === 0 && !adapter.dirs.has(folder)) {
			throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${folder}'`), { code: "ENOENT" });
		}
		return { files, folders: [] };
	};
	const exists = adapter.exists.bind(adapter);
	const stat = adapter.stat.bind(adapter);
	const read = adapter.read.bind(adapter);
	/** Called with every path `exists` is asked about, before it answers. */
	let onLook: ((p: string) => void) | null = null;
	adapter.exists = async (p: string) => {
		onLook?.(p);
		const f = faults.get(p);
		if (f && f.kind !== "stat-eio") return false;
		// A folder is there while it holds a file, as on disk.
		return (await exists(p)) || inFolder(p).length > 0;
	};
	adapter.stat = async (p: string) => {
		calls.stat.push(p);
		const f = faults.get(p);
		if (f?.kind === "unseen") throw Object.assign(new Error(`EACCES: permission denied, stat '${p}'`), { code: "EACCES" });
		if (f?.kind === "codeless-missing") throw new Error(`could not stat ${p}`);
		if (f?.kind === "stat-eio") throw Object.assign(new Error(`EIO: i/o error, stat '${p}'`), { code: "EIO" });
		return stat(p);
	};
	adapter.read = async (p: string) => {
		calls.read.push(p);
		const f = faults.get(p);
		if (f?.kind === "unseen" && f.readFails) {
			throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: "EACCES" });
		}
		return read(p);
	};
	function fault(path: string, kind: Fault, readFails = false) {
		faults.set(path, { kind, readFails });
	}
	function heal(path: string) {
		faults.delete(path);
	}
	function whenLookedAt(path: string, then: () => void) {
		let done = false;
		onLook = (p) => {
			if (done || p !== path) return;
			done = true;
			then();
		};
	}
	return { adapter, calls, fault, heal, whenLookedAt };
}

type Disk = ReturnType<typeof disk>;

let clock = 5_000_000;
beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	clock = 5_000_000;
});

function store(d: Disk) {
	return new PageStore({ vault: { adapter: d.adapter } } as never, F, () => clock);
}

/** The store's announcements, as the views would get them. */
function announced(s: PageStore) {
	const said = { promoted: [] as string[], keptAside: [] as string[], restored: [] as string[] };
	s.onFlushPromoted = (_id, keptAs) => said.promoted.push(keptAs);
	s.onFlushKeptAside = (_id, keptAs) => said.keptAside.push(keptAs);
	s.onInkTrashRestored = (_id, restoredTo) => said.restored.push(restoredTo);
	return said;
}

const ids = (page: { data: PageData } | null | undefined) => page?.data.strokes.map((x) => x.id);
const liveOf = (id: string) => `${F}/${id}.json`;

/** Every generation of `id` in the ink trash. */
function trashed(d: Disk, id: string): string[] {
	return [...d.adapter.files.keys()].filter((p) => p.startsWith(`${F}/trash/${id}-`) && p.endsWith(".json")).sort();
}

/** Every write, rename and remove on any file of `id` since `mark`. */
function touched(d: Disk, id: string, mark: number): string[] {
	return d.adapter.log.slice(mark).filter((l) => l.includes(`/${id}.`) || l.includes(`/${id}-`));
}

/** A live file holding s1 and s2, and beside it a background flush's carrier holding s1 only, built on older bytes. */
function liveWithCarrier(d: Disk, id: string) {
	const live = liveOf(id);
	const liveText = JSON.stringify(pageOf(id, "s1", "s2"));
	d.adapter.files.set(live, liveText);
	d.adapter.mtimes.set(live, 42);
	const carrier = `${live}.flush`;
	const older = JSON.stringify(pageOf(id, "s0"));
	const carrierText = JSON.stringify({ flushBase: contentStamp(older), flushInFlight: [], page: pageOf(id, "s1") });
	d.adapter.files.set(carrier, carrierText);
	d.adapter.mtimes.set(carrier, 43);
	return { live, liveText, carrier, carrierText };
}

/**
 * No live file when the load first looks, and a carrier holding s1. As the load first asks about the carrier, the live
 * file lands (a sync, another device: s1 and s2), and from then on the look at it fails.
 */
function carrierThenLiveLands(d: Disk, id: string, readFails: boolean) {
	const live = liveOf(id);
	const liveText = JSON.stringify(pageOf(id, "s1", "s2"));
	const carrier = `${live}.flush`;
	const carrierText = JSON.stringify({ flushBase: null, flushInFlight: [], page: pageOf(id, "s1") });
	d.adapter.files.set(carrier, carrierText);
	d.adapter.mtimes.set(carrier, 43);
	d.whenLookedAt(carrier, () => {
		d.adapter.externalWrite(live, liveText);
		d.fault(live, "unseen", readFails);
	});
	return { live, liveText, carrier, carrierText };
}

/**
 * The note was inked with s1, deleted (its ink file went to the trash), restored and inked again: its live file holds
 * s1 and s2 and the trash still holds the older generation. With `live` false the live file never came back.
 */
async function liveWithTrashGeneration(d: Disk, id: string, live = true) {
	const path = liveOf(id);
	d.adapter.files.set(path, JSON.stringify(pageOf(id, "s1")));
	d.adapter.mtimes.set(path, 42);
	const s = store(d);
	await s.load(id);
	await s.remove(id);
	expect(trashed(d, id), "precondition: the delete moved the ink file to the trash").toHaveLength(1);
	expect(d.adapter.files.has(path), "precondition: the delete moved the live ink file away").toBe(false);
	const generation = trashed(d, id)[0]!;
	const generationText = d.adapter.files.get(generation)!;
	clock += 1000;
	const liveText = JSON.stringify(pageOf(id, "s1", "s2"));
	if (live) d.adapter.externalWrite(path, liveText);
	return { live: path, liveText, generation, generationText };
}

/** Page Y, read normally, in the same store. */
function pageY(d: Disk) {
	d.adapter.files.set(liveOf(Y), JSON.stringify(pageOf(Y, "y-s1")));
	d.adapter.mtimes.set(liveOf(Y), 40);
}

/** The load ended as a read that threw does, for that page only. */
function endedAsAThrownRead(s: PageStore, id: string, got: Awaited<ReturnType<PageStore["load"]>>) {
	expect(got, "the load answered nothing, as for a page with no ink file").not.toBeNull();
	expect(got?.transient, "the load was not marked transient").toBe(true);
	expect(got?.damaged, "the load was not marked damaged").toBe(true);
	expect(ids(got), "the load served strokes it could not have read").toEqual([]);
	expect(got?.damagedPath, "the load named another file").toBe(liveOf(id));
	expect(s.unreadable.has(id) && s.unreadable.get(id) === null, "the page is not watched as a read that threw").toBe(true);
	expect(s.observedMissing.has(id), "the page was marked missing while its file was there").toBe(false);
}

describe.each([false, true])("a load that cannot look at the live ink file (its read fails too: %s)", (readFails) => {
	it("with a background flush's carrier beside it: the live bytes stay, the carrier stays, and the load ends as a read that threw", async () => {
		const d = disk();
		const a = liveWithCarrier(d, X);
		pageY(d);
		d.fault(a.live, "unseen", readFails);
		const s = store(d);
		const said = announced(s);
		const mark = d.adapter.log.length;
		const [got, y] = await Promise.all([s.load(X), s.load(Y)]);
		expect(d.adapter.files.get(a.live), "the carrier was written over the live ink file the load could not see").toBe(a.liveText);
		expect(d.adapter.files.get(a.carrier), "the carrier was moved or removed").toBe(a.carrierText);
		endedAsAThrownRead(s, X, got);
		expect(said, "the load announced a carrier or a restore").toEqual({ promoted: [], keptAside: [], restored: [] });
		expect(touched(d, X, mark), "the load wrote, renamed or removed a file of this page").toEqual([]);
		expect(y?.damaged ?? false, "the other page did not load").toBe(false);
		expect(ids(y), "the other page lost its ink").toEqual(["y-s1"]);
	});

	it("with no live file at the first look, then one landing that the second look cannot see: the carrier is not written over it", async () => {
		const d = disk();
		const a = carrierThenLiveLands(d, X, readFails);
		pageY(d);
		const s = store(d);
		const said = announced(s);
		const mark = d.adapter.log.length;
		const [got, y] = await Promise.all([s.load(X), s.load(Y)]);
		expect(d.adapter.files.get(a.live), "the carrier was written over the live ink file that landed").toBe(a.liveText);
		expect(d.adapter.files.get(a.carrier), "the carrier was moved or removed").toBe(a.carrierText);
		endedAsAThrownRead(s, X, got);
		expect(said, "the load announced a carrier or a restore").toEqual({ promoted: [], keptAside: [], restored: [] });
		expect(touched(d, X, mark), "the load wrote, renamed or removed a file of this page").toEqual([]);
		expect(ids(y), "the other page lost its ink").toEqual(["y-s1"]);
	});

	it("with an older generation in the ink trash: it is not renamed over the live file, and the load ends as a read that threw", async () => {
		const d = disk();
		const b = await liveWithTrashGeneration(d, X);
		pageY(d);
		d.fault(b.live, "unseen", readFails);
		const s = store(d);
		const said = announced(s);
		const mark = d.adapter.log.length;
		const [got, y] = await Promise.all([s.load(X), s.load(Y)]);
		expect(d.adapter.files.get(b.live), "an older generation from the trash was renamed over the live ink file").toBe(b.liveText);
		expect(d.adapter.files.get(b.generation), "the generation left the trash").toBe(b.generationText);
		endedAsAThrownRead(s, X, got);
		expect(said, "the load announced a carrier or a restore").toEqual({ promoted: [], keptAside: [], restored: [] });
		expect(touched(d, X, mark), "the load wrote, renamed or removed a file of this page").toEqual([]);
		expect(ids(y), "the other page lost its ink").toEqual(["y-s1"]);
	});
});

describe("a PDF's ink file the load cannot look at", () => {
	it("with a carrier beside it: the live bytes stay and the carrier stays, as for a note", async () => {
		const d = disk();
		const a = liveWithCarrier(d, PDF);
		d.fault(a.live, "unseen");
		const s = store(d);
		const mark = d.adapter.log.length;
		const got = await s.load(PDF, { restore: false });
		expect(d.adapter.files.get(a.live), "the carrier was written over the PDF's live ink file").toBe(a.liveText);
		expect(d.adapter.files.get(a.carrier), "the carrier was moved or removed").toBe(a.carrierText);
		endedAsAThrownRead(s, PDF, got);
		expect(touched(d, PDF, mark), "the load wrote, renamed or removed a file of this PDF").toEqual([]);
	});
});

describe("the poll, while the look keeps failing", () => {
	let now = 1_000_000;
	beforeEach(() => {
		now = 1_000_000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
	});

	async function twoTicks(s: PageStore, id: string) {
		for (const tick of [1, 2]) {
			now += 6000;
			expect(await s.externallyChanged(id), `poll tick ${tick} did not ask for a reload`).toBe(true);
			endedAsAThrownRead(s, id, await s.load(id));
		}
	}

	it("with a carrier: each reload ends as a read that threw again, and nothing is written", async () => {
		const d = disk();
		const a = liveWithCarrier(d, X);
		d.fault(a.live, "unseen");
		const s = store(d);
		const mark = d.adapter.log.length;
		endedAsAThrownRead(s, X, await s.load(X));
		await twoTicks(s, X);
		expect(d.adapter.files.get(a.live), "the live ink file was replaced").toBe(a.liveText);
		expect(d.adapter.files.get(a.carrier), "the carrier was moved or removed").toBe(a.carrierText);
		expect(touched(d, X, mark), "a reload wrote, renamed or removed a file of this page").toEqual([]);
	});

	it("with a live file that landed after the first look: each reload ends as a read that threw again, and nothing is written", async () => {
		const d = disk();
		const a = carrierThenLiveLands(d, X, false);
		const s = store(d);
		const mark = d.adapter.log.length;
		endedAsAThrownRead(s, X, await s.load(X));
		await twoTicks(s, X);
		expect(d.adapter.files.get(a.live), "the live ink file was replaced").toBe(a.liveText);
		expect(d.adapter.files.get(a.carrier), "the carrier was moved or removed").toBe(a.carrierText);
		expect(touched(d, X, mark), "a reload wrote, renamed or removed a file of this page").toEqual([]);
	});

	it("with a trash generation: each reload ends as a read that threw again, and the trash keeps it", async () => {
		const d = disk();
		const b = await liveWithTrashGeneration(d, X);
		d.fault(b.live, "unseen");
		const s = store(d);
		const mark = d.adapter.log.length;
		endedAsAThrownRead(s, X, await s.load(X));
		await twoTicks(s, X);
		expect(d.adapter.files.get(b.live), "the live ink file was replaced").toBe(b.liveText);
		expect(d.adapter.files.get(b.generation), "the generation left the trash").toBe(b.generationText);
		expect(touched(d, X, mark), "a reload wrote, renamed or removed a file of this page").toEqual([]);
	});
});

describe("when the look works again", () => {
	it("with a carrier built on older bytes: the live page is served and the carrier is kept aside and announced, as today", async () => {
		const d = disk();
		const a = liveWithCarrier(d, X);
		d.fault(a.live, "unseen");
		const s = store(d);
		const said = announced(s);
		endedAsAThrownRead(s, X, await s.load(X));
		d.heal(a.live);
		const got = await s.load(X);
		expect(got?.damaged ?? false, "the healed page is still locked").toBe(false);
		expect(ids(got), "the healed page is not the live file's").toEqual(["s1", "s2"]);
		expect(d.adapter.files.get(a.live), "the live ink file was replaced").toBe(a.liveText);
		expect(d.adapter.files.has(a.carrier), "the carrier was not judged").toBe(false);
		expect(said.keptAside, "the carrier was not kept aside and announced").toHaveLength(1);
		expect(d.adapter.files.has(said.keptAside[0] ?? ""), "the kept-aside copy is not on disk").toBe(true);
		expect(said.promoted, "the carrier was promoted over newer bytes").toEqual([]);
	});

	it("with a trash generation: the live page is served and the trash keeps the generation", async () => {
		const d = disk();
		const b = await liveWithTrashGeneration(d, X);
		d.fault(b.live, "unseen");
		const s = store(d);
		const said = announced(s);
		endedAsAThrownRead(s, X, await s.load(X));
		d.heal(b.live);
		const got = await s.load(X);
		expect(got?.damaged ?? false, "the healed page is still locked").toBe(false);
		expect(ids(got), "the healed page is not the live file's").toEqual(["s1", "s2"]);
		expect(d.adapter.files.get(b.generation), "the generation left the trash").toBe(b.generationText);
		expect(said.restored, "a restore was announced").toEqual([]);
	});
});

describe("a live file that `exists` misses but `stat` and `read` meet", () => {
	it("with a carrier built on older bytes: the live page is served and the carrier is kept aside and announced", async () => {
		const d = disk();
		const a = liveWithCarrier(d, X);
		d.fault(a.live, "access-only");
		const s = store(d);
		const said = announced(s);
		const got = await s.load(X);
		expect(d.adapter.files.get(a.live), "the carrier was written over the live ink file").toBe(a.liveText);
		expect(got?.damaged ?? false, "the page was locked").toBe(false);
		expect(ids(got), "the page served is not the live file's").toEqual(["s1", "s2"]);
		expect(said.keptAside, "the carrier was not kept aside and announced").toHaveLength(1);
		expect(said.promoted, "the carrier was promoted over newer bytes").toEqual([]);
	});

	it("with a trash generation: the live page is served and the trash keeps the generation", async () => {
		const d = disk();
		const b = await liveWithTrashGeneration(d, X);
		d.fault(b.live, "access-only");
		const s = store(d);
		const said = announced(s);
		const got = await s.load(X);
		expect(d.adapter.files.get(b.live), "an older generation from the trash was renamed over the live ink file").toBe(b.liveText);
		expect(ids(got), "the page served is not the live file's").toEqual(["s1", "s2"]);
		expect(d.adapter.files.get(b.generation), "the generation left the trash").toBe(b.generationText);
		expect(said.restored, "a restore was announced").toEqual([]);
	});
});

describe("a page with no live ink file, as today", () => {
	it("with a carrier: the carrier's page is served and written as the live file", async () => {
		const d = disk();
		const a = liveWithCarrier(d, X);
		d.adapter.files.delete(a.live);
		const got = await store(d).load(X);
		expect(ids(got), "the carrier's page was not served").toEqual(["s1"]);
		expect(d.adapter.files.has(a.live), "the carrier's page was not written as the live file").toBe(true);
		expect(d.adapter.files.has(a.carrier), "the carrier was left beside the page it became").toBe(false);
	});

	it("with a trash generation: the generation comes back and is announced", async () => {
		const d = disk();
		const b = await liveWithTrashGeneration(d, X, false);
		const s = store(d);
		const said = announced(s);
		const got = await s.load(X);
		expect(ids(got), "the trashed ink did not come back").toEqual(["s1"]);
		expect(said.restored, "the restore was not announced").toEqual([b.live]);
	});

	it("where the host's not-found error has no code: it opens blank, is marked missing, and its stroke is kept", async () => {
		const d = disk();
		d.fault(liveOf(X), "codeless-missing");
		const s = store(d);
		expect(await s.load(X), "a page with no ink file was locked or served something").toBeNull();
		expect(s.observedMissing.has(X), "a page with no ink file was not marked missing").toBe(true);
		d.heal(liveOf(X));
		await s.saveNow(X, pageOf(X, "first"));
		expect(ids(await store(d).load(X)), "the stroke on the blank page was not kept").toEqual(["first"]);
	});

	it("where the host's not-found error has no code and the trash holds a generation: it comes back", async () => {
		const d = disk();
		const b = await liveWithTrashGeneration(d, X, false);
		d.fault(b.live, "codeless-missing");
		const s = store(d);
		const said = announced(s);
		const got = await s.load(X);
		expect(ids(got), "the trashed ink did not come back").toEqual(["s1"]);
		expect(said.restored, "the restore was not announced").toEqual([b.live]);
	});
});

describe("a page whose live ink file is seen, as today", () => {
	it("a stat that fails beside a read that works: the page is served", async () => {
		const d = disk();
		d.adapter.files.set(liveOf(X), JSON.stringify(pageOf(X, "s1", "s2")));
		d.fault(liveOf(X), "stat-eio");
		const got = await store(d).load(X);
		expect(got?.damaged ?? false, "the page was locked").toBe(false);
		expect(ids(got), "the page was not served").toEqual(["s1", "s2"]);
	});

	it("makes one stat and one read of its file, and lists nothing", async () => {
		const d = disk();
		d.adapter.files.set(liveOf(X), JSON.stringify(pageOf(X, "s1", "s2")));
		d.adapter.mtimes.set(liveOf(X), 42);
		const got = await store(d).load(X);
		expect(ids(got), "the page was not served").toEqual(["s1", "s2"]);
		expect(d.calls.stat.filter((p) => p === liveOf(X)), "stats of the live file").toHaveLength(1);
		expect(d.calls.read.filter((p) => p === liveOf(X)), "reads of the live file").toHaveLength(1);
		expect(d.calls.list, "listings").toEqual([]);
	});

	it("a page with no ink file: at most one stat of where it would be, and no read of it", async () => {
		const d = disk();
		expect(await store(d).load(X), "a page with no ink file was locked or served something").toBeNull();
		expect(d.calls.stat.filter((p) => p === liveOf(X)).length, "stats of the absent live file").toBeLessThanOrEqual(1);
		expect(d.calls.read.filter((p) => p === liveOf(X)), "reads of the absent live file").toEqual([]);
		console.info(`[count] absent page: ${d.calls.stat.filter((p) => p === liveOf(X)).length} stat of the live path, ${d.calls.list.length} listings`);
	});
});
