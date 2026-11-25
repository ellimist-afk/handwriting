/**
 * Deleting a note never destroys a revision another device syncs in while the
 * delete runs. The revision lands right before one adapter call the delete
 * makes, one run per call index, until a run makes fewer calls than the index:
 * that run is the delete with no revision. In every run with a revision, the
 * revision ends live or in the ink trash, byte for byte.
 *
 * The hook counts calls and nothing else. It never waits for a method or a
 * path, so a delete that changes its calls or their order is still tried at
 * each call it makes.
 *
 * Arms (each run builds a fresh vault and a fresh store):
 *  A  no save queued, the page pinned by a load; the live file is an empty page.
 *  B  as A, never loaded, so the delete looks the page up.
 *  C  a save queued (its write failed); the live file is the bytes this session loaded.
 *  D  as C, but the queued page is empty (everything erased inside the debounce).
 *  E  as A, with an earlier session's flush carrier beside the page.
 *  F  a save queued with this session's own flush carrier, which the queued page covers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";

(globalThis as { window?: unknown }).window = globalThis;
afterEach(() => vi.useRealTimers());

const LIVE = ".handwriting/X.json";
const TMP = ".handwriting/X.json.tmp";
const CARRIER = ".handwriting/X.json.flush";
const TRASH = ".handwriting/trash/";
const ROOT_FILE = /^\.handwriting\/[^/]+$/;
const RESTORABLE = /^\.handwriting\/trash\/X-\d+(-\d+)?(-external)?\.json$/;
const CAP = 60;

function pageOf(id: string, ...labels: string[]): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = labels.map((l) => ({
		id: l,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
	})) as PageData["strokes"];
	return p;
}

/** Another device's revision: a stroke id unique to the run, and a top-level field this build does not know. */
function revisionPage(k: number): string {
	const page = JSON.parse(serializePage(pageOf("X", `other-${k}`))) as Record<string, unknown>;
	page.laterField = { run: k };
	return JSON.stringify(page);
}

function carrierOf(pageText: string): string {
	return `{"flushBase":null,"page":${pageText}}`;
}

/** The page a carrier holds, as the store writes it into the trash. */
function pageFormOf(carrier: string): string {
	const raw = JSON.parse(carrier) as { page: unknown };
	return serializePage(parsePage(JSON.stringify(raw.page), "X").data);
}

/** A page file as the store writes it after a read, so fields a read fills in compare equal; null when it does not parse. */
function readForm(text: string): string | null {
	const parsed = parsePage(text, "X");
	return parsed.damaged ? null : serializePage(parsed.data);
}

function isCarrier(text: string): boolean {
	return text.startsWith(`{"flushBase"`);
}

/** Stroke ids of a page file, or of the page inside a carrier; null when it does not parse. */
function idsIn(text: string): string[] | null {
	let inner = text;
	if (isCarrier(text)) {
		try {
			inner = JSON.stringify((JSON.parse(text) as { page: unknown }).page);
		} catch {
			return null;
		}
	}
	const parsed = parsePage(inner, "X");
	return parsed.damaged ? null : parsed.data.strokes.map((s) => s.id);
}

const STRANDED = serializePage(pageOf("X", "stranded"));
const OLD_CARRIER = carrierOf(serializePage(pageOf("X", "flushed")));

/** The vault, with the folder listing a restore needs, counting every call the delete makes. */
class CountingAdapter extends FakeAdapter {
	armed = false;
	n = 0;
	landAt = 0;
	throwAt = 0;
	target = LIVE;
	revision = "";
	fired = false;
	thrown = false;
	calls: string[] = [];
	/** Each file's bytes at the start of the delete, with the call number of the remove that took them off the disk. */
	watched = new Map<string, number | undefined>();

	private tick(call: string): void {
		if (!this.armed) return;
		this.n++;
		this.calls.push(call);
		if (this.n === this.landAt) {
			this.externalWrite(this.target, this.revision);
			this.fired = true;
		}
		if (this.n === this.throwAt) {
			this.thrown = true;
			throw new Error(`injected failure at call ${this.n}: ${call}`);
		}
	}

	override async exists(path: string): Promise<boolean> {
		this.tick(`exists ${path}`);
		return super.exists(path);
	}

	override async read(path: string): Promise<string> {
		this.tick(`read ${path}`);
		return super.read(path);
	}

	override async write(path: string, data: string): Promise<void> {
		this.tick(`write ${path}`);
		return super.write(path, data);
	}

	override async rename(from: string, to: string): Promise<void> {
		this.tick(`rename ${from} -> ${to}`);
		return super.rename(from, to);
	}

	override async remove(path: string): Promise<void> {
		this.tick(`remove ${path}`);
		const text = this.files.get(path);
		if (this.armed && text !== undefined && this.watched.has(text)) this.watched.set(text, this.n);
		return super.remove(path);
	}

	override async mkdir(path: string): Promise<void> {
		this.tick(`mkdir ${path}`);
		return super.mkdir(path);
	}

	override async stat(path: string): Promise<{ mtime: number; size?: number } | null> {
		this.tick(`stat ${path}`);
		return super.stat(path);
	}

	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		this.tick(`list ${path}`);
		const prefix = path.endsWith("/") ? path : `${path}/`;
		const files = [...this.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"));
		if (files.length === 0 && !this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
		return { files, folders: [] };
	}
}

/**
 * As CountingAdapter, and a write of a generation in the trash empties its file and then fails, as a write the app is
 * killed in. With no queued page the one trash write is the carrier's page, under -flush or as a plain generation.
 */
class TruncatingAdapter extends CountingAdapter {
	truncated = false;

	override async write(path: string, data: string): Promise<void> {
		if (this.armed && /trash\/X-[^/]*\.json$/.test(path)) {
			await super.write(path, "");
			this.truncated = true;
			throw new Error(`injected failure after emptying ${path}`);
		}
		return super.write(path, data);
	}
}

/** A newer build's page: its one stroke is under a point key this build does not read. */
const FUTURE = `{"schemaVersion":3,"pageId":"X","surface":"inline","strokes":[{"id":"n1","ptsq":[0,0,10,0]}]}`;

function freshStore(fake: FakeAdapter): PageStore {
	return new PageStore({ vault: { adapter: fake } }, ".handwriting", () => 5000);
}

interface Arm {
	name: string;
	/** Builds the vault and the store. `ready` runs right before the delete, with no await between them. */
	setup(fake: CountingAdapter): Promise<{ store: PageStore; ready?: () => void }>;
	/** Stroke ids of the queued page, when it holds any. */
	queued?: string[];
	/** The kept revision's trash name carries -external. */
	external: boolean;
	/** What a restore opens when the revision is in the trash and no live file is left. */
	restores(k: number): string[];
	/** The delete with no revision: files gone, files added (tag and stroke ids), files changed. */
	clean: { removed: string[]; added: string[] };
}

async function loaded(fake: CountingAdapter, text: string): Promise<PageStore> {
	fake.dirs.add(".handwriting");
	fake.externalWrite(LIVE, text);
	const store = freshStore(fake);
	await store.load("X");
	return store;
}

async function failedSave(fake: CountingAdapter, page: PageData): Promise<PageStore> {
	const store = await loaded(fake, serializePage(pageOf("X", "base")));
	fake.failWriteTimes = 1;
	await store.saveNow("X", page);
	if (!store.hasQueuedWrite("X")) throw new Error("setup: the failed save left nothing queued");
	return store;
}

const ARMS: Arm[] = [
	{
		name: "A",
		setup: async (fake) => ({ store: await loaded(fake, serializePage(pageOf("X"))) }),
		external: false,
		restores: (k) => [`other-${k}`],
		clean: { removed: [LIVE], added: [] },
	},
	{
		name: "B",
		setup: async (fake) => {
			fake.dirs.add(".handwriting");
			fake.externalWrite(LIVE, serializePage(pageOf("X")));
			return { store: freshStore(fake) };
		},
		external: false,
		restores: (k) => [`other-${k}`],
		clean: { removed: [LIVE], added: [] },
	},
	{
		name: "C",
		setup: async (fake) => ({ store: await failedSave(fake, pageOf("X", "base", "mine")) }),
		queued: ["base", "mine"],
		external: true,
		restores: () => ["base", "mine"],
		clean: { removed: [LIVE], added: ["plain:base,mine"] },
	},
	{
		name: "D",
		setup: async (fake) => ({ store: await failedSave(fake, pageOf("X")) }),
		external: true,
		restores: (k) => [`other-${k}`],
		clean: { removed: [LIVE], added: [] },
	},
	{
		name: "E",
		setup: async (fake) => {
			const store = await loaded(fake, serializePage(pageOf("X")));
			fake.externalWrite(CARRIER, OLD_CARRIER);
			return { store };
		},
		external: false,
		restores: (k) => [`other-${k}`],
		// The carrier holds every stroke of the empty live page and names no saves in flight, so load would open it: the
		// delete files its page as a plain generation, which a restore opens.
		clean: { removed: [LIVE, CARRIER], added: ["plain:flushed"] },
	},
	{
		name: "F",
		setup: async (fake) => {
			const store = await loaded(fake, serializePage(pageOf("X", "base")));
			return {
				store,
				ready: () => {
					store.schedule("X", pageOf("X", "base", "queued"));
					store.flushDispatch();
				},
			};
		},
		queued: ["base", "queued"],
		external: true,
		restores: () => ["base", "queued"],
		clean: { removed: [LIVE, CARRIER], added: ["plain:base,queued"] },
	},
];
const arm = (name: string): Arm => ARMS.find((a) => a.name === name)!;

interface Run {
	k: number;
	fired: boolean;
	thrown: boolean;
	calls: string[];
	revision: string;
	before: Map<string, string>;
	after: Map<string, string>;
	/** The adapter's mutation log for the delete alone. */
	log: string[];
	watched: Map<string, number | undefined>;
	removeError: string | null;
	queuedAgain: boolean;
	ownTmp: boolean;
	/** What a fresh store opens, when the delete left no live file. */
	restored: string[] | null;
}

interface Opts {
	target?: string;
	refuse?: boolean;
	seed?: (fake: CountingAdapter) => void;
	/** The revision's text, in place of revisionPage(k). */
	revision?: string;
}

async function runOne(a: Arm, k: number, mode: "land" | "throw", opts: Opts): Promise<Run> {
	vi.useFakeTimers();
	const fake = new CountingAdapter();
	const { store, ready } = await a.setup(fake);
	opts.seed?.(fake);
	ready?.();
	fake.refuseRenameOntoFile = opts.refuse ?? false;
	const target = opts.target ?? LIVE;
	fake.target = target;
	fake.revision = opts.revision ?? (target === CARRIER ? carrierOf(revisionPage(k)) : revisionPage(k));
	if (mode === "land") fake.landAt = k;
	else fake.throwAt = k;
	const before = new Map(fake.files);
	for (const text of before.values()) fake.watched.set(text, undefined);
	fake.log = [];
	fake.armed = true;
	let removeError: string | null = null;
	await store.remove("X").catch((err: unknown) => {
		removeError = String(err);
	});
	fake.armed = false;
	const after = new Map(fake.files);
	const log = [...fake.log];
	const queuedAgain = store.hasQueuedWrite("X");
	const ownTmp = store.ownTmp.has(TMP);
	const restored = after.has(LIVE) ? null : ((await freshStore(fake).load("X"))?.data.strokes.map((s) => s.id) ?? []);
	vi.useRealTimers();
	return {
		k,
		fired: fake.fired,
		thrown: fake.thrown,
		calls: fake.calls,
		revision: fake.revision,
		before,
		after,
		log,
		watched: fake.watched,
		removeError,
		queuedAgain,
		ownTmp,
		restored,
	};
}

/** Runs k = 1, 2, ... until a run makes fewer than k calls; that last run is the delete with no revision (or no failure). */
async function sweep(a: Arm, mode: "land" | "throw", opts: Opts = {}): Promise<{ runs: Run[]; ended: boolean }> {
	const runs: Run[] = [];
	for (let k = 1; k <= CAP; k++) {
		const run = await runOne(a, k, mode, opts);
		runs.push(run);
		if (mode === "land" ? !run.fired : !run.thrown) return { runs, ended: true };
	}
	return { runs, ended: false };
}

function where(r: Run): string {
	return `k=${r.k} (before call ${r.k}: ${r.calls[r.k - 1] ?? "none"})`;
}

const inTrash = (path: string): boolean => path.startsWith(TRASH);

/** Where the run's revision is kept: the target path itself or a trash file, byte for byte (a carrier also as its page). */
function keptAt(r: Run, target: string): string | null {
	const form = target === CARRIER ? pageFormOf(r.revision) : null;
	for (const [path, text] of r.after) {
		if (path !== target && !inTrash(path)) continue;
		if (text === r.revision) return path;
		if (form !== null && inTrash(path) && text === form) return path;
	}
	return null;
}

function tagOf(path: string): string {
	const m = /^\.handwriting\/trash\/X-\d+(?:-\d+)?(?:-([a-z]+))?\.json$/.exec(path);
	if (!m) return path;
	return m[1] ?? "plain";
}

const targets = [
	{ label: "live file", path: LIVE },
	{ label: "flush carrier", path: CARRIER },
];

describe("a revision landing during a delete is never destroyed", () => {
	for (const t of targets) {
		for (const a of ARMS) {
			const row = t.path === LIVE ? "G1/G8" : "G14";
			it(`${row} ${a.name}, revision at the ${t.label}: kept live or in the trash, byte for byte, at every call`, async () => {
				const { runs } = await sweep(a, "land", { target: t.path });
				const lost = runs
					.filter((r) => r.fired && keptAt(r, t.path) === null)
					.map((r) => `${where(r)}: gone; files ${[...r.after.keys()].sort().join(", ")}`);
				expect(lost, `${a.name}: a revision landing at the ${t.label} was destroyed`).toEqual([]);
			});
		}
	}

	for (const t of targets) {
		for (const a of ARMS) {
			it(`G4 ${a.name}, revision at the ${t.label}: the runs end at the delete's own last call, under the cap`, async () => {
				const { runs, ended } = await sweep(a, "land", { target: t.path });
				const last = runs[runs.length - 1]!;
				console.log(
					`[remove-revision] ${a.name} ${t.label}: ${runs.length} runs, no-revision run k=${last.k}; calls: ${last.calls.join(" | ")}`
				);
				expect(ended, `${a.name}: still firing after ${CAP} runs`).toBe(true);
				expect(last.fired, `${a.name}: the last run had a revision`).toBe(false);
			});
		}
	}

	const g5 = [...ARMS.map((a) => ({ a, t: targets[0]! })), { a: arm("E"), t: targets[1]! }, { a: arm("F"), t: targets[1]! }];
	for (const { a, t } of g5) {
		it(`G5 ${a.name}, revision at the ${t.label}: it ends in the trash in one run and live in another`, async () => {
			const { runs } = await sweep(a, "land", { target: t.path });
			const places = runs
				.filter((r) => r.fired)
				.map((r) => {
					const p = keptAt(r, t.path);
					return p === null ? "gone" : inTrash(p) ? "trash" : "live";
				});
			expect(
				{ trash: places.includes("trash"), live: places.includes("live") },
				`${a.name}: run by run from k=1: ${places.join(",")}`
			).toEqual({ trash: true, live: true });
		});
	}

	for (const a of ARMS) {
		const row = a.name === "C" || a.name === "F" ? "G6/G7" : "G6";
		it(`${row} ${a.name}: a revision kept in the trash has a name a restore takes, and a restore opens ${a.name === "C" || a.name === "F" ? "the queued page" : "it"}`, async () => {
			const { runs } = await sweep(a, "land");
			const bad: string[] = [];
			for (const r of runs.filter((x) => x.fired)) {
				const p = keptAt(r, LIVE);
				if (p !== null && inTrash(p)) {
					if (!RESTORABLE.test(p)) bad.push(`${where(r)}: kept as ${p}, which no restore takes`);
					else if (p.endsWith("-external.json") !== a.external) bad.push(`${where(r)}: kept as ${p}`);
				}
				if (r.restored !== null && JSON.stringify(r.restored) !== JSON.stringify(a.restores(r.k))) {
					bad.push(`${where(r)}: a restore opened ${JSON.stringify(r.restored)}`);
				}
			}
			expect(bad, `${a.name}: kept where a restore cannot find it, or the wrong copy opens`).toEqual([]);
		});
	}

	it("G6 A2: with an older plain generation in the trash, a restore opens the revision, never the older one", async () => {
		const older = (fake: CountingAdapter): void => {
			fake.dirs.add(".handwriting/trash");
			fake.externalWrite(".handwriting/trash/X-3000.json", serializePage(pageOf("X", "older")));
		};
		const { runs } = await sweep(arm("A"), "land", { seed: older });
		const bad = runs
			.filter((r) => r.fired && r.restored !== null && JSON.stringify(r.restored) !== JSON.stringify([`other-${r.k}`]))
			.map((r) => `${where(r)}: a restore opened ${JSON.stringify(r.restored)}`);
		expect(bad, "A2: the older generation opened, or nothing did").toEqual([]);
	});

	for (const a of ARMS) {
		it(`G9 ${a.name}: the delete with no revision leaves the files it always left`, async () => {
			const { runs } = await sweep(a, "land");
			const r = runs[runs.length - 1]!;
			const removed = [...r.before.keys()].filter((p) => !r.after.has(p)).sort();
			const added = [...r.after.keys()]
				.filter((p) => !r.before.has(p))
				.map((p) => `${tagOf(p)}:${(idsIn(r.after.get(p)!) ?? ["unreadable"]).join(",")}`)
				.sort();
			const changed = [...r.before.keys()].filter((p) => r.after.has(p) && r.after.get(p) !== r.before.get(p));
			expect({ removed, added, changed }, `${a.name}: calls ${r.calls.join(" | ")}`).toEqual({
				removed: [...a.clean.removed].sort(),
				added: [...a.clean.added].sort(),
				changed: [],
			});
		});
	}

	for (const refuse of [false, true]) {
		it(`G10 A, a stranded save beside the page, ${refuse ? "renames onto a file refused" : "renames overwrite"}: it stays whole in one -tmp generation, the revision is kept, no new file in the ink folder`, async () => {
			const stranded = (fake: CountingAdapter): void => fake.externalWrite(TMP, STRANDED);
			const { runs } = await sweep(arm("A"), "land", { seed: stranded, refuse });
			const bad: string[] = [];
			for (const r of runs) {
				const copies = [...r.after].filter(([p, text]) => inTrash(p) && tagOf(p) === "tmp" && text === STRANDED);
				if (copies.length !== 1 || r.after.has(TMP)) {
					bad.push(`${where(r)}: the stranded save is in ${copies.length} -tmp generations, live .tmp ${r.after.has(TMP)}`);
				}
				if (r.fired && keptAt(r, LIVE) === null) bad.push(`${where(r)}: the revision is gone`);
				const fresh = [...r.after.keys()].filter((p) => ROOT_FILE.test(p) && !r.before.has(p));
				if (fresh.length > 0) bad.push(`${where(r)}: new in the ink folder: ${fresh.join(", ")}`);
			}
			expect(bad, "A: the stranded save, the revision, or the ink folder").toEqual([]);
		});
	}

	for (const name of ["A", "C"]) {
		it(`G11 ${name}: a stranded save and an earlier session's carrier beside the page both reach the trash, the carrier's page once`, async () => {
			const both = (fake: CountingAdapter): void => {
				fake.externalWrite(TMP, STRANDED);
				fake.externalWrite(CARRIER, OLD_CARRIER);
			};
			const { runs } = await sweep(arm(name), "land", { seed: both });
			const flushed = pageFormOf(OLD_CARRIER);
			const bad: string[] = [];
			for (const r of runs) {
				const tmps = [...r.after].filter(([p, text]) => inTrash(p) && tagOf(p) === "tmp" && text === STRANDED);
				// With no queued page (A) the carrier is judged as load judges it, against the live bytes the delete moved:
				// a plain generation when load would open it, -flush when not. With a queued page (C) it stays -flush.
				const tags = name === "A" ? ["flush", "plain"] : ["flush"];
				const flushes = [...r.after].filter(([p, text]) => inTrash(p) && tags.includes(tagOf(p)) && text === flushed);
				if (tmps.length !== 1) bad.push(`${where(r)}: ${tmps.length} -tmp generations hold the stranded save`);
				if (flushes.length !== 1) bad.push(`${where(r)}: ${flushes.length} ${tags.join(" or ")} generations hold the carrier's page`);
				if (r.after.has(TMP) || r.after.has(CARRIER)) bad.push(`${where(r)}: left live: .tmp ${r.after.has(TMP)}, carrier ${r.after.has(CARRIER)}`);
				if (name === "C" && r.ownTmp) bad.push(`${where(r)}: the .tmp name is still marked as this store's own`);
			}
			expect(bad, `${name}: the scratch files beside the page`).toEqual([]);
		});
	}

	for (const a of ARMS) {
		it(`G12 ${a.name}: a call that fails loses nothing the delete had not already let go of`, async () => {
			const { runs, ended } = await sweep(a, "throw");
			expect(ended, `${a.name}: still failing after ${CAP} runs`).toBe(true);
			const bad: string[] = [];
			for (const r of runs.filter((x) => x.thrown)) {
				const onDisk = [...r.after.values()];
				for (const [text, removedAt] of r.watched) {
					// A carrier is also kept by a page file holding its page: the queued generation, when the queued page
					// covers it, is written straight from memory, without the fields a read fills in.
					const form = isCarrier(text) ? pageFormOf(text) : null;
					const kept = onDisk.includes(text) || (form !== null && onDisk.some((t) => !isCarrier(t) && readForm(t) === form));
					if (kept) continue;
					if (removedAt !== undefined && removedAt < r.k) continue;
					const was = [...r.before].find(([, t]) => t === text)?.[0] ?? "?";
					bad.push(`${where(r)}: the bytes of ${was} are gone (removed at call ${removedAt ?? "none"})`);
				}
				if (a.queued !== undefined) {
					const want = a.queued.join(",");
					const held = onDisk.some((text) => idsIn(text)?.join(",") === want);
					if (!held && !r.queuedAgain) bad.push(`${where(r)}: the queued page is on no file and not queued again`);
				}
			}
			expect(bad, `${a.name}: a failed call lost bytes`).toEqual([]);
		});
	}

	for (const a of ARMS) {
		it(`G13 ${a.name}: the delete never renames anything onto the live path`, async () => {
			const runs = [...(await sweep(a, "land")).runs, ...(await sweep(a, "throw")).runs];
			const onto = runs.flatMap((r) => r.log.filter((l) => l.endsWith(`-> ${LIVE}`)).map((l) => `${r.thrown ? "throw" : "land"} ${where(r)}: ${l}`));
			expect(onto, `${a.name}: a rename onto ${LIVE}`).toEqual([]);
		});
	}

	it("G15 E: a write of the carrier's page into the trash that empties its file and then fails leaves the carrier's ink on a file", async () => {
		vi.useFakeTimers();
		const fake = new TruncatingAdapter();
		const { store } = await arm("E").setup(fake);
		fake.armed = true;
		await store.remove("X").catch(() => undefined);
		fake.armed = false;
		vi.useRealTimers();
		const held = [...fake.files].some(
			([p, text]) => p.startsWith(".handwriting/") && JSON.stringify(idsIn(text)) === JSON.stringify(["flushed"])
		);
		expect(
			{ truncated: fake.truncated, held },
			`E: the carrier's strokes are on no file; files ${[...fake.files.keys()].sort().join(", ")}`
		).toEqual({ truncated: true, held: true });
	});

	it("G16 A, a revision a newer build wrote, its stroke under a key this build does not read: kept live or in the trash, byte for byte, at every call", async () => {
		const { runs } = await sweep(arm("A"), "land", { revision: FUTURE });
		const fired = runs.filter((r) => r.fired);
		const lost = fired
			.filter((r) => keptAt(r, LIVE) === null)
			.map((r) => `${where(r)}: gone; files ${[...r.after.keys()].sort().join(", ")}`);
		expect(
			{ fired: fired.length > 0, lost },
			"A: a newer build's revision was judged empty and destroyed"
		).toEqual({ fired: true, lost: [] });
	});
});
