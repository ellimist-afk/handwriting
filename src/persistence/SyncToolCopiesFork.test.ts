/**
 * A copy Syncthing, Dropbox or iCloud keeps when two devices changed the same
 * ink file holds the other device's strokes. The fork scan lists it as a kept
 * copy against its live page, for a note page and a PDF page alike, so it
 * reaches the same fork screen as a copy the plugin kept itself. A name that
 * only looks like one is not listed, and the plugin's own copies list as
 * before. A decision on such a copy sticks: the copy is renamed, nothing is
 * lost, and no later scan lists it. A sync tool's copy of one of the
 * plugin's own copies is not listed against a page that does not exist.
 *
 * The real scan, decision and modal run over synthetic disk bytes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
	Modal: class { constructor(_app: unknown) {} },
	Notice: class { constructor(_text: string) {} },
}));
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";
import { FakeAdapter } from "./FakeAdapter";
import { applyForkDecision, listForks, recordFork, refreshForks, resetForks, scanForForks, type ForkHost } from "./ForkResolution";
import { parsePage, serializePage } from "../model/PageData";
import { ForkResolutionModal } from "./ForkResolutionModal";

const FOLDER = ".handwriting";
const NOTE = "3b7d9e21-0c4a-4f6e-8a15-2d9c7b4e6f80";
const PDF = "pdf-9f2c41d07a5e6b38";

const COPY_NAMES: [tool: string, name: (id: string) => string][] = [
	["Syncthing", (id) => `${id}.sync-conflict-20261105-120000-ABCDEFG.json`],
	["Dropbox", (id) => `${id} (Alan's conflicted copy 2026-11-05).json`],
	["iCloud", (id) => `${id} 2.json`],
];

function page(id: string, ...strokes: string[]): string {
	return JSON.stringify({ schemaVersion: 1, pageId: id, surface: "inline", textBoxes: [], images: [],
		strokes: strokes.map((s) => ({ id: s, tool: "pen", color: "#5f6673", width: 2.86, createdAt: 1700000000000,
			pts: [10, 20, 0.5, 0, 11, 21, 0.5, 1] })) });
}

function vault(files: Record<string, string>) {
	const disk = new FakeAdapter();
	for (const [p, text] of Object.entries(files)) disk.externalWrite(p, text);
	const host: ForkHost = {
		deviceId: "device-here",
		read: async (p) => (disk.files.has(p) ? disk.read(p) : null),
		stat: (p) => disk.stat(p),
		list: async () => [...disk.files.keys()].map((p) => p.slice(p.lastIndexOf("/") + 1)),
		saveNow: async () => {},
		restore: async (id, data) => disk.externalWrite(`${FOLDER}/${id}.json`, serializePage(data)),
		rename: (from, to) => disk.rename(from, to),
	};
	return Object.assign(host, { disk });
}

/** The live page and one other file beside it. */
function liveAnd(id: string, other: string) {
	return vault({ [`${FOLDER}/${id}.json`]: page(id, "this-device"), [`${FOLDER}/${other}`]: page(id, "this-device", "other-device") });
}

async function screenButtons(host: ForkHost): Promise<string[]> {
	for (const rec of await scanForForks(host, FOLDER)) recordFork(rec);
	const modal = new ForkResolutionModal({} as never, host);
	const content = new FakeEl("div", new FakeDoc());
	(modal as unknown as { contentEl: FakeEl }).contentEl = content;
	await modal.onOpen();
	const all = (el: FakeEl): FakeEl[] => [...el.children].flatMap((c) => [c as FakeEl, ...all(c as FakeEl)]);
	return all(content).filter((e) => e.tagName === "button").map((b) => b.textContent);
}

beforeEach(() => resetForks());

describe("a sync tool's conflict copy is listed once as a kept copy against its live page", () => {
	for (const [tool, name] of COPY_NAMES) {
		for (const [kind, id] of [["note", NOTE], ["PDF", PDF]] as const) {
			it(`${tool}, ${kind} page`, async () => {
				const forks = await scanForForks(liveAnd(id, name(id)), FOLDER);
				expect(forks).toHaveLength(1);
				expect(forks[0]).toMatchObject({
					pageId: id,
					outgoingPath: `${FOLDER}/${id}.json`,
					incomingPath: `${FOLDER}/${name(id)}`,
					kept: true,
				});
			});
		}
	}

	it("a Syncthing copy reaches the same fork screen, with the same choices, as a copy the plugin kept", async () => {
		const own = await screenButtons(liveAnd(NOTE, `${NOTE}.conflict-1700000000000.json`));
		resetForks();
		const synced = await screenButtons(liveAnd(NOTE, COPY_NAMES[0]![1](NOTE)));
		expect(own.length).toBeGreaterThan(0);
		expect(synced).toEqual(own);
	});
});

describe("a decision on a sync tool's copy sticks", () => {
	for (const [tool, name] of COPY_NAMES) {
		for (const [kind, id] of [["note", NOTE], ["PDF", PDF]] as const) {
			for (const decision of ["keep-mine", "take-theirs"] as const) {
				it(`${tool}, ${kind} page, ${decision}: no later scan lists the copy, and its bytes are kept`, async () => {
					const host = liveAnd(id, name(id));
					const copy = host.disk.files.get(`${FOLDER}/${name(id)}`)!;
					const [rec] = await scanForForks(host, FOLDER);
					recordFork(rec!);
					expect(await applyForkDecision(host, rec!, decision)).toMatchObject({ kind: "applied", stillListed: false });
					resetForks();
					await refreshForks(host, FOLDER);
					expect(listForks()).toEqual([]);
					expect(await scanForForks(host, FOLDER)).toEqual([]);
					const kept = [...host.disk.files.keys()].filter((p) => p.includes(".conflict-resolved-sync-"));
					expect(kept).toEqual([`${FOLDER}/${id}.conflict-resolved-sync-${rec!.at}.json`]);
					expect(host.disk.files.get(kept[0]!)).toBe(copy);
					const live = parsePage(host.disk.files.get(`${FOLDER}/${id}.json`)!, id).data.strokes.map((s) => s.id);
					expect(live).toEqual(decision === "keep-mine" ? ["this-device"] : ["this-device", "other-device"]);
				});
			}
		}
	}

	it("a resolved name already taken gets the next number; the file there is untouched", async () => {
		const host = liveAnd(NOTE, COPY_NAMES[0]![1](NOTE));
		const [rec] = await scanForForks(host, FOLDER);
		const taken = `${FOLDER}/${NOTE}.conflict-resolved-sync-${rec!.at}.json`;
		host.disk.externalWrite(taken, "earlier");
		recordFork(rec!);
		await applyForkDecision(host, rec!, "keep-mine");
		expect(host.disk.files.get(taken)).toBe("earlier");
		expect(host.disk.files.has(`${FOLDER}/${NOTE}.conflict-resolved-sync-${rec!.at}-2.json`)).toBe(true);
		expect(await scanForForks(host, FOLDER)).toEqual([]);
	});
});

describe("a sync tool's copy of the plugin's own copy names no live page", () => {
	it("an iCloud copy of a kept copy is not listed; the kept copy still is", async () => {
		const host = vault({
			[`${FOLDER}/${NOTE}.json`]: page(NOTE, "a"),
			[`${FOLDER}/${NOTE}.conflict-1700000000000.json`]: page(NOTE, "a", "b"),
			[`${FOLDER}/${NOTE}.conflict-1700000000000 2.json`]: page(NOTE, "a", "c"),
		});
		const forks = await scanForForks(host, FOLDER);
		expect(forks.map((f) => [f.pageId, f.incomingPath])).toEqual([
			[NOTE, `${FOLDER}/${NOTE}.conflict-1700000000000.json`],
		]);
	});

	it.each([
		["iCloud copy of a pair leg", `${NOTE}.conflict-external-T-outgoing 2.json`],
		["Syncthing copy of a damaged copy", `${NOTE}.damaged-1700000000000.sync-conflict-20261105-120000-ABCDEFG.json`],
	])("%s is not listed", async (_label, other) => {
		expect(await scanForForks(liveAnd(NOTE, other), FOLDER)).toEqual([]);
	});
});

describe("a Syncthing copy from a release that wrote no device part", () => {
	it.each([["note", NOTE], ["PDF", PDF]] as const)("is listed against its live %s page", async (_kind, id) => {
		const name = `${id}.sync-conflict-20170101-120000.json`;
		const forks = await scanForForks(liveAnd(id, name), FOLDER);
		expect(forks.map((f) => [f.pageId, f.incomingPath])).toEqual([[id, `${FOLDER}/${name}`]]);
	});
});

describe("controls", () => {
	it("the plugin's own kept copy and ink-folder move copy list as before", async () => {
		const host = vault({
			[`${FOLDER}/${NOTE}.json`]: page(NOTE, "a"),
			[`${FOLDER}/${NOTE}.conflict-1700000000000.json`]: page(NOTE, "a", "b"),
			[`${FOLDER}/${NOTE}.conflict-migration-1700000000123.json`]: page(NOTE, "a", "c"),
		});
		const forks = await scanForForks(host, FOLDER);
		expect(forks.map((f) => f.incomingPath).sort()).toEqual([
			`${FOLDER}/${NOTE}.conflict-1700000000000.json`,
			`${FOLDER}/${NOTE}.conflict-migration-1700000000123.json`,
		]);
		expect(forks.every((f) => f.kept && f.pageId === NOTE)).toBe(true);
	});

	it.each([
		["Syncthing name with no date", `${NOTE}.sync-conflict-copy.json`],
		["Dropbox-like name that is not a conflicted copy", `${NOTE} (Alan's copy 2026-11-05).json`],
		["iCloud-like name numbered 1", `${NOTE} 1.json`],
		["a plain second id", `${NOTE}-2.json`],
	])("a near-miss name is not listed: %s", async (_label, other) => {
		expect(await scanForForks(liveAnd(NOTE, other), FOLDER)).toEqual([]);
	});
});
