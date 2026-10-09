/**
 * Persistence ownership over synthetic bytes.
 * Both user folder changes and startup preservation run real migration over
 * synthetic bytes. Broken JSON needs a minted name, or text that opens with a
 * brace and holds both page keys as the serializer writes them.
 * Disk contents, rename calls and counts are separate soft assertions.
 */
import { describe, expect, it } from "vitest";
import { changeFolder, migrateInkFolder, type MigrationAdapter } from "./InkFolder";
import { FakeAdapter } from "./FakeAdapter";

const FROM = ".handwriting";
const TO = "handwriting";
const UUID = "504fdb34-aed8-42a0-8df8-66f7db7a02de";
const PREFIX = '{"schemaVersion":1,"pageId":"';
const minted = [UUID, "page-1700000000000-abc123", "pdf-9f86d081", "pdf-9f86d081-2"];
const accepted = [
	["zero", '{"schemaVersion":0,"pageId":"'],
	["one digit", PREFIX],
	["several digits", '{"schemaVersion":123,"pageId":"'],
	["BOM", "\uFEFF" + PREFIX],
	["leading whitespace", " \t\r\n" + PREFIX],
	["BOM and whitespace", "\uFEFF \t\r\n" + PREFIX],
	["unknown first key", '{"foreign":true,"schemaVersion":1,"pageId":"'],
	["wrong key order", '{"pageId":"x","schemaVersion":1,'],
	["space after comma", '{"schemaVersion":1, "pageId":"'],
] as const;
const rejected = [
	["arbitrary broken text", "foreign unfinished text"],
	["space after brace", '{ "schemaVersion":1,"pageId":"'],
	["space before version", '{"schemaVersion": 1,"pageId":"'],
	["space after version", '{"schemaVersion":1 ,"pageId":"'],
	["space before page id", '{"schemaVersion":1,"pageId": "'],
	["signed version", '{"schemaVersion":-1,"pageId":"'],
	["fractional version", '{"schemaVersion":1.5,"pageId":"'],
	["missing version digits", '{"schemaVersion":,"pageId":"'],
	["quoted version", '{"schemaVersion":"1","pageId":"'],
	["page id not quoted", '{"schemaVersion":1,"pageId":'],
] as const;

function fixture(name: string, bytes: string, destination?: string) {
	const disk = new FakeAdapter();
	disk.dirs.add(FROM);
	disk.externalWrite(`${FROM}/${name}`, bytes);
	if (destination !== undefined) disk.externalWrite(`${TO}/${name}`, destination);
	const renames: Array<[string, string]> = [];
	const reads: string[] = [];
	const adapter: MigrationAdapter = {
		exists: (p) => disk.exists(p),
		mkdir: async (p) => { disk.dirs.add(p); },
		read: async (p) => { reads.push(p); return disk.read(p); },
		rename: async (a, b) => { renames.push([a, b]); await disk.rename(a, b); },
		list: async (folder) => ({ files: [...disk.files.keys()].filter((p) => p.startsWith(folder + "/")), folders: [] }),
	};
	return { disk, adapter, renames, reads };
}

describe.each(["folder change", "startup preservation"] as const)("broken bare JSON ownership on %s", (mode) => {
	async function move(adapter: MigrationAdapter) {
		if (mode === "startup preservation") return migrateInkFolder(adapter, FROM, TO, { preserveCollisions: true });
		const outcome = await changeFolder({
			settle: async () => true,
			migrate: (a, b) => migrateInkFolder(adapter, a, b),
			repoint: () => {},
			persist: async () => {},
		}, FROM, TO);
		expect(outcome.kind).toBe("moved");
		if (outcome.kind !== "moved") throw new Error("Folder did not move");
		return outcome.result;
	}

	async function check(name: string, bytes: string, shouldMove: boolean) {
		expect(() => JSON.parse(bytes), "premise: bare JSON is broken").toThrow();
		const { disk, adapter, renames } = fixture(name, bytes);
		const result = await move(adapter);
		expect.soft(result.moved, "moved count").toBe(shouldMove ? 1 : 0);
		expect.soft(result.skipped, "foreign file is not a collision").toBe(0);
		expect.soft(renames, "rename calls").toEqual(shouldMove ? [[`${FROM}/${name}`, `${TO}/${name}`]] : []);
		expect.soft(disk.files.get(`${FROM}/${name}`), "source bytes").toBe(shouldMove ? undefined : bytes);
		expect.soft(disk.files.get(`${TO}/${name}`), "destination bytes").toBe(shouldMove ? bytes : undefined);
	}

	it.each(minted)("moves broken JSON under minted id %s", async (id) => check(`${id}.json`, "{unrelated broken bytes", true));
	it.each(accepted)("moves custom name with both page keys as written: %s", async (_label, text) => check("hand-edited.json", text, true));
	it.each(rejected)("leaves foreign broken bare JSON: %s", async (_label, text) => check("foreign-config.json", text, false));
	it.each(rejected)("minted name still owns bytes with rejected prefix: %s", async (_label, text) => check(`${UUID}.json`, text, true));
	it("does not confuse a safe custom id with a minted id", async () => check("safe-custom-id.json", "{", false));

	it.each(["x.json.tmp", "x.json.flush", "x.damaged-1.json", "x.conflict-1.json", "x.superseded-1.json", "x.flush-conflict-1.json"])("moves recovery carrier %s without reading it", async (name) => {
		const { disk, adapter, renames, reads } = fixture(name, "preserved bytes");
		const result = await move(adapter);
		expect.soft(reads).toEqual([]);
		expect.soft(result.moved).toBe(1);
		expect.soft(renames).toEqual([[`${FROM}/${name}`, `${TO}/${name}`]]);
		expect.soft(disk.files.get(`${TO}/${name}`)).toBe("preserved bytes");
	});

	it("leaves unrelated parseable JSON in place", async () => {
		const { disk, adapter, renames } = fixture("config.json", '{"setting":true}');
		const result = await move(adapter);
		expect.soft(result.moved).toBe(0);
		expect.soft(renames).toEqual([]);
		expect.soft(disk.files.get(`${FROM}/config.json`)).toBe('{"setting":true}');
	});

	it("keeps collision bytes under the existing policy", async () => {
		const name = `${UUID}.json`;
		const { disk, adapter, renames } = fixture(name, PREFIX, "destination bytes");
		const result = await move(adapter);
		expect.soft(disk.files.get(`${TO}/${name}`)).toBe("destination bytes");
		expect.soft(result.moved).toBe(0);
		if (mode === "folder change") {
			expect.soft(result.skipped).toBe(1);
			expect.soft(renames).toEqual([]);
			expect.soft(disk.files.get(`${FROM}/${name}`)).toBe(PREFIX);
		} else {
			expect.soft(result.preserved).toBe(1);
			expect.soft(result.skipped).toBe(0);
			expect(renames).toHaveLength(1);
			expect.soft(renames[0]![1]).toMatch(/\.conflict-migration-\d+(?:-\d+)?\.json$/);
			expect.soft(disk.files.get(renames[0]![1])).toBe(PREFIX);
		}
	});
});
