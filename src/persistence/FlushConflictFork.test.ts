/**
 * "FIX INK DE-SYNC" AND THE COPY A CUT-OFF SAVE LEAVES.
 *
 * Obsidian quits, or a phone puts it away, in the middle of a save. On the next open the save's carrier is found
 * built on other bytes than the live page, so the live page stands and the carrier's page is kept aside as
 * `<id>.flush-conflict-<mtime>.json`, and a notice names that file. The command that is the way back for every
 * other kept copy did not list it: it said there was nothing to fix, and the newest strokes were reachable only by
 * a file manager and a hand merge.
 *
 * The copy is now listed against its live page as a kept copy, with the Version A / Version B choices every kept
 * copy has. A decision renames it to a name no scan lists and that is never a live page; nothing is deleted. A copy
 * whose own write was cut off (bytes that do not parse) is not listed. A superseded copy, a damaged copy, a decided
 * copy and a sync tool's copy of the copy are never listed.
 *
 * The copies are written by the real PageStore load over an in-memory adapter, as the app writes them; the
 * decisions run the fork host the plugin builds, sliced out of RegisterCommands.ts as ForkPdfInkHeld.test.ts does,
 * over the real PageStore and PdfInkStore. No Obsidian, no sync tool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { installFakeWindow } from "../../test/routerHarness";
installFakeWindow();

import { transformSync } from "esbuild";
import commandsSource from "../commands/RegisterCommands.ts?raw";
import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { isLiveSidecarName } from "./InkFolder";
import { InlineInkStore } from "../inline/InlineInkStore";
import { PdfInkStore } from "../pdf/PdfInkStore";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";
import {
	applyForkDecision,
	describeFork,
	forkHostFor,
	recordFork,
	resetForks,
	scanForForks,
	type ForkHost,
} from "./ForkResolution";

const FOLDER = ".handwriting";
const NOTE = "3b7d9e21-0c4a-4f6e-8a15-2d9c7b4e6f80";
const PDF = "pdf-9f2c41d07a5e6b38";
const KINDS = [
	["note", NOTE, "inline"],
	["PDF", PDF, "pdf"],
] as const;
type Surface = "inline" | "pdf";

/** The in-memory adapter, listing the direct files of a folder as the vault adapter does. */
class ListingAdapter extends FakeAdapter {
	async list(folder: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = `${folder}/`;
		const files = [...this.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"));
		return { files, folders: [] };
	}
}

const live = (id: string) => `${FOLDER}/${id}.json`;

/** One stroke per id; `x` is where its first point sits, so a move changes the points and not the id. */
function pageWith(id: string, surface: Surface, ...strokes: Array<[sid: string, x: number]>): PageData {
	const p = emptyPage(id);
	p.surface = surface;
	p.strokes = strokes.map(([sid, x]) => ({
		id: sid,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x, y: 0, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x, y: 0, width: 10, height: 0 },
		createdAt: 0,
		...(surface === "pdf" ? { page: 1 } : {}),
	}));
	return p;
}

/** Each stroke as `id@x`, in page order; null when the file is not there. */
function shape(text: string | undefined, id: string): string[] | null {
	if (text === undefined) return null;
	return parsePage(text, id).data.strokes.map((s) => `${s.id}@${s.points[0]!.x}`);
}

let held: Array<() => void>;

async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

/**
 * A store loads the live page with S at 0, then backgrounding writes a carrier holding S at 0 and L at 50 while its
 * own save is held, and the app is killed. Another device then moves S to 100 and that page syncs in. Returns the
 * files as the next start finds them, and the name the next load gives the kept copy.
 */
async function cutOffSave(id: string, surface: Surface): Promise<{ disk: ListingAdapter; copyName: string; carrierMtime: number }> {
	const first = new ListingAdapter();
	first.files.set(live(id), serializePage(pageWith(id, surface, ["S", 0])));
	first.mtimes.set(live(id), ++first.clock);
	const store = new PageStore({ vault: { adapter: first } } as never, FOLDER);
	await store.load(id);
	const tmp = `${live(id)}.tmp`;
	const write = first.write.bind(first);
	first.write = (path: string, data: string) => {
		if (path !== tmp) return write(path, data);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		held.push(release);
		return gate.then(() => write(path, data));
	};
	store.schedule(id, pageWith(id, surface, ["S", 0], ["L", 50]));
	store.flushDispatch();
	await settle();
	const carrier = `${live(id)}.flush`;
	expect(first.files.has(carrier), "precondition: the carrier is on disk").toBe(true);
	const disk = new ListingAdapter();
	for (const [k, v] of first.files) disk.files.set(k, v);
	for (const [k, v] of first.mtimes) disk.mtimes.set(k, v);
	disk.clock = first.clock;
	disk.files.set(live(id), serializePage(pageWith(id, surface, ["S", 100])));
	disk.mtimes.set(live(id), ++disk.clock);
	const carrierMtime = disk.mtimes.get(carrier)!;
	return { disk, copyName: `${FOLDER}/${id}.flush-conflict-${carrierMtime}.json`, carrierMtime };
}

/** The plugin's fork host: the forkHostFor call in RegisterCommands.ts, run with `this` and the ink store stood in. */
function pluginHost(self: unknown, ink: InlineInkStore): ForkHost {
	const from = "const host: ForkHost = forkHostFor({";
	const to = "// Every folder a page can be served from";
	const source = commandsSource.replace(/\r\n/g, "\n");
	expect(source.split(from), "the fork host is built once in RegisterCommands.ts").toHaveLength(2);
	const at = source.indexOf(from);
	const end = source.indexOf(to, at);
	expect(end, "the fork host's sources end where the folder scan starts").toBeGreaterThan(at);
	const js = transformSync(`${source.slice(at, end)}\nreturn host;`, { loader: "ts" }).code;
	return new Function("self", "forkHostFor", "inlineInk", "inkExternallyReloaded", "slidesDeckHolds", js.replace(/\bthis\b/g, "self"))(
		self,
		forkHostFor,
		ink,
		() => {},
		() => false,
	) as ForkHost;
}

interface Device {
	store: PageStore;
	pdf: PdfInkStore;
	host: ForkHost;
}

/** One device over `disk`: its PageStore, its PdfInkStore wired to it as the plugin wires it, and the plugin's fork host. */
function device(disk: ListingAdapter): Device {
	const store = new PageStore({ vault: { adapter: disk } } as never, FOLDER, () => 5_000_000);
	const pdf = new PdfInkStore();
	pdf.attachHost({
		load: (id, options) => store.load(id, options),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => {},
	});
	const ink = new InlineInkStore();
	ink.attachHost({
		readPageId: () => null,
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: (id: string) => store.load(id),
		scheduleSidecar: (id: string, p: PageData) => store.schedule(id, p),
		scheduleSidecarNow: (id: string, p: PageData) => store.saveNow(id, p),
		notify: () => {},
	} as never);
	const self = {
		app: { vault: { adapter: disk, getFileByPath: () => null } },
		store,
		installId: () => "this-device",
		notePathFor: () => null,
		pdfStore: pdf,
		pdfInk: new Map(),
		pdfIds: new Map(),
	};
	return { store, pdf, host: pluginHost(self, ink) };
}

/** The next start opens the page: a note through the store, a PDF through the PDF store, as the app does. */
async function open(d: Device, id: string, surface: Surface): Promise<void> {
	if (surface === "pdf") {
		await d.pdf.ensureLoaded(id);
		expect(d.pdf.inkReady(id), "precondition: the PDF read soundly").toBe(true);
	} else {
		await d.store.load(id);
	}
}

const decidedName = (copy: string) => copy.replace(/\.flush-conflict-(?=\d+(?:-\d+)?\.json$)/, ".conflict-resolved-flush-");

beforeEach(() => {
	held = [];
	resetForks();
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	for (const release of held) release();
	vi.restoreAllMocks();
});

describe("a cut-off save's copy is listed as a kept copy", () => {
	for (const [kind, id, surface] of KINDS) {
		it(`${kind} page: listed against its live page, needs a decision, Keep Version B writes the copy's page, and the next scan lists nothing`, async () => {
			const { disk, copyName } = await cutOffSave(id, surface);
			const d = device(disk);
			await open(d, id, surface);
			expect(shape(disk.files.get(live(id)), id), "precondition: the live page stands").toEqual(["S@100"]);
			expect(shape(disk.files.get(copyName), id), "precondition: the load kept the carrier's page aside under this name").toEqual(["S@0", "L@50"]);
			const copyBytes = disk.files.get(copyName)!;

			const forks = await scanForForks(d.host, FOLDER);
			expect(forks, "one kept record for the page").toEqual([
				{ pageId: id, path: id, outgoingPath: live(id), incomingPath: copyName, at: expect.any(Number), kept: true },
			]);
			const account = await describeFork(d.host, forks[0]!);
			expect(account, "the copy holds a stroke the live page lacks").toMatchObject({ needsDecision: true, theirsOnly: 1 });
			expect(account.undecidable, "the copy reads").toBeUndefined();

			recordFork(forks[0]!);
			const out = await applyForkDecision(d.host, forks[0]!, "take-theirs");
			expect(out, "Keep Version B wrote the live page").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
			expect(shape(disk.files.get(live(id)), id), "the live page is the copy's page").toEqual(["S@0", "L@50"]);
			if (surface === "pdf") {
				expect(d.pdf.strokes(id).map((s) => `${s.id}@${s.points[0]!.x}`), "the open PDF holds the copy's page").toEqual(["S@0", "L@50"]);
			}
			expect(disk.files.has(copyName), "the copy is no longer under its scanned name").toBe(false);
			expect(disk.files.get(decidedName(copyName)), "the copy's bytes are kept under the decided name").toBe(copyBytes);
			expect(
				[...disk.files].some(([p, t]) => p.startsWith(`${FOLDER}/trash/`) && shape(t, id)?.join() === "S@100"),
				"the page it replaced was copied aside first",
			).toBe(true);
			resetForks();
			expect(await scanForForks(d.host, FOLDER), "the next scan lists nothing").toEqual([]);
		});
	}

	it("note page: Keep Version A leaves the live page as it is, and the decided copy is not listed at the next scan", async () => {
		const { disk, copyName } = await cutOffSave(NOTE, "inline");
		const d = device(disk);
		await open(d, NOTE, "inline");
		const liveBytes = disk.files.get(live(NOTE))!;
		const copyBytes = disk.files.get(copyName)!;
		const forks = await scanForForks(d.host, FOLDER);
		expect(forks.map((f) => f.incomingPath), "the copy is listed").toEqual([copyName]);
		recordFork(forks[0]!);
		expect(await applyForkDecision(d.host, forks[0]!, "keep-mine")).toMatchObject({ kind: "applied", wrote: false, stillListed: false });
		expect(disk.files.get(live(NOTE)), "the live page is as it was").toBe(liveBytes);
		expect(disk.files.get(decidedName(copyName)), "the copy's bytes are kept under the decided name").toBe(copyBytes);
		resetForks();
		expect(await scanForForks(d.host, FOLDER), "the next scan lists nothing").toEqual([]);
	});

	it("a copy whose own write was cut off is not listed; the whole copy the next load writes is", async () => {
		const { disk, copyName } = await cutOffSave(NOTE, "inline");
		const whole = serializePage(pageWith(NOTE, "inline", ["S", 0], ["L", 50]));
		disk.externalWrite(copyName, whole.slice(0, Math.floor(whole.length / 2)));
		const d = device(disk);
		await open(d, NOTE, "inline");
		const next = copyName.replace(/\.json$/, "-2.json");
		expect(shape(disk.files.get(next), NOTE), "precondition: the next load wrote the whole copy beside the part").toEqual(["S@0", "L@50"]);
		const forks = await scanForForks(d.host, FOLDER);
		expect(forks.map((f) => f.incomingPath), "only the whole copy is listed").toEqual([next]);
	});

	it("an earlier whole copy under the same name: both are listed, each is decided, and the next scan lists nothing", async () => {
		const { disk, copyName } = await cutOffSave(NOTE, "inline");
		disk.externalWrite(copyName, serializePage(pageWith(NOTE, "inline", ["S", 0], ["E", 30])));
		const d = device(disk);
		await open(d, NOTE, "inline");
		const next = copyName.replace(/\.json$/, "-2.json");
		const forks = await scanForForks(d.host, FOLDER);
		expect(forks.map((f) => f.incomingPath).sort(), "both copies are listed").toEqual([copyName, next].sort());
		for (const rec of forks) {
			recordFork(rec);
			expect(await applyForkDecision(d.host, rec, "keep-mine")).toMatchObject({ kind: "applied", stillListed: false });
		}
		expect(disk.files.has(decidedName(copyName)) && disk.files.has(decidedName(next)), "each kept under its own decided name").toBe(true);
		resetForks();
		expect(await scanForForks(d.host, FOLDER)).toEqual([]);
	});

	it("a copy holding nothing the live page lacks is listed and needs no decision, so it is not put on screen", async () => {
		const disk = new ListingAdapter();
		disk.externalWrite(live(NOTE), serializePage(pageWith(NOTE, "inline", ["S", 0], ["L", 50])));
		const copy = `${FOLDER}/${NOTE}.flush-conflict-1700.json`;
		disk.externalWrite(copy, serializePage(pageWith(NOTE, "inline", ["S", 0])));
		const d = device(disk);
		const forks = await scanForForks(d.host, FOLDER);
		expect(forks.map((f) => f.incomingPath)).toEqual([copy]);
		expect((await describeFork(d.host, forks[0]!)).needsDecision).toBe(false);
	});
});

describe("pins: never listed", () => {
	/** The live page, and beside it one file holding a stroke the live page lacks. */
	function liveAnd(id: string, surface: Surface, other: string): ForkHost {
		const disk = new ListingAdapter();
		disk.externalWrite(live(id), serializePage(pageWith(id, surface, ["S", 0])));
		disk.externalWrite(`${FOLDER}/${other}`, serializePage(pageWith(id, surface, ["S", 0], ["L", 50])));
		return device(disk).host;
	}

	for (const [kind, id, surface] of KINDS) {
		const cases: Array<[what: string, name: string]> = [
			["a superseded copy", `${id}.superseded-1700.json`],
			["a superseded copy, numbered", `${id}.superseded-1700-2.json`],
			["a damaged copy", `${id}.damaged-1700.json`],
			["a decided cut-off copy", `${id}.conflict-resolved-flush-1700.json`],
			["a decided cut-off copy, numbered", `${id}.conflict-resolved-flush-1700-2.json`],
			["Syncthing's copy of a cut-off copy", `${id}.flush-conflict-1700.sync-conflict-20261116-120000-ABCDEFG.json`],
			["Dropbox's copy of a cut-off copy", `${id}.flush-conflict-1700 (Alan's conflicted copy 2026-11-16).json`],
			["iCloud's copy of a cut-off copy", `${id}.flush-conflict-1700 2.json`],
		];
		for (const [what, name] of cases) {
			it(`${kind} page: ${what} is not listed`, async () => {
				expect(await scanForForks(liveAnd(id, surface, name), FOLDER)).toEqual([]);
			});
		}
	}

	it("a decided cut-off copy is never a live page", () => {
		expect(isLiveSidecarName(`${NOTE}.conflict-resolved-flush-1700.json`)).toBe(false);
		expect(isLiveSidecarName(`${NOTE}.conflict-resolved-flush-1700-2.json`)).toBe(false);
	});
});

describe("controls: the copies listed before are listed as before", () => {
	it("a save guard's copy, a folder move's copy and a sync tool's copy each list once against the live page", async () => {
		const disk = new ListingAdapter();
		disk.externalWrite(live(NOTE), serializePage(pageWith(NOTE, "inline", ["S", 0])));
		const names = [`${NOTE}.conflict-1700.json`, `${NOTE}.conflict-migration-1701.json`, `${NOTE}.sync-conflict-20261116-120000-ABCDEFG.json`];
		for (const n of names) disk.externalWrite(`${FOLDER}/${n}`, serializePage(pageWith(NOTE, "inline", ["S", 0], ["L", 50])));
		const forks = await scanForForks(device(disk).host, FOLDER);
		expect(forks.map((f) => [f.incomingPath, f.outgoingPath, f.kept]).sort()).toEqual(
			names.map((n) => [`${FOLDER}/${n}`, live(NOTE), true]).sort(),
		);
	});
});
