/**
 * A COPY THE SAVE GUARD KEPT, AS FIX INK DE-SYNC SEES IT.
 *
 * `<id>.conflict-<mtime>.json` is another revision the save guard moved aside
 * before writing this device's page. The live page is this device's side of
 * that fork, and the copy is the other. These cells pin what the scenario
 * cells do not reach: which names are listed, which way the question is
 * asked, and that no decision ever renames or rewrites the live page when
 * this device's side is chosen.
 *
 * Real `scanForForks`, `describeFork` and `applyForkDecision` over an
 * in-memory host.
 */
import { describe, expect, it } from "vitest";
import { applyForkDecision, describeFork, ForkHost, scanForForks } from "./ForkResolution";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";

const FOLDER = "ink";
const ID = "p1";
const LIVE = `${FOLDER}/${ID}.json`;

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 1, y: 2, pressure: 0.5, t: 0 },
			{ x: 11, y: 6, pressure: 0.5, t: 8 },
		],
		bbox: { x: 1, y: 2, width: 10, height: 4 },
		createdAt: 0,
	};
}

function bytes(ids: string[]): string {
	const p = emptyPage(ID);
	p.surface = "inline";
	p.strokes = ids.map(stroke);
	return serializePage(p);
}

function host(files: Map<string, string>): ForkHost & { renames: [string, string][]; writes: number } {
	const h = {
		renames: [] as [string, string][],
		writes: 0,
		read: async (p: string) => files.get(p) ?? null,
		stat: async (p: string) => (files.has(p) ? { mtime: 7 } : null),
		saveNow: async (_id: string, data: PageData) => {
			h.writes++;
			files.set(LIVE, serializePage(data));
		},
		rename: async (from: string, to: string) => {
			h.renames.push([from, to]);
			files.set(to, files.get(from)!);
			files.delete(from);
		},
		list: async () => [...files.keys()],
	};
	return h;
}

describe("a copy the save guard kept is a fork against the live page", () => {
	it("is listed under its page id with the live page as this device's side; pairs, resolved names and the other kept-aside labels are not kept copies", async () => {
		const files = new Map([
			[LIVE, bytes(["mine"])],
			[`${FOLDER}/${ID}.conflict-1700.json`, bytes(["theirs"])],
			[`${FOLDER}/${ID}.conflict-1700-2.json`, bytes(["theirs-2"])],
			[`${FOLDER}/${ID}.conflict-resolved-1600.json`, bytes(["old"])],
			[`${FOLDER}/${ID}.flush-conflict-1650.json`, bytes(["flushed"])],
			[`${FOLDER}/${ID}.superseded-1650.json`, bytes(["superseded"])],
			[`${FOLDER}/${ID}.damaged-1650.json`, "{ not a page"],
			[`${FOLDER}/${ID}.conflict-external-abc-outgoing.json`, bytes(["mine"])],
			[`${FOLDER}/${ID}.conflict-external-abc-incoming.json`, bytes(["theirs"])],
		]);
		const found = await scanForForks(host(files), FOLDER);
		const kept = found.filter((r) => r.outgoingPath === LIVE).map((r) => [r.pageId, r.outgoingPath, r.incomingPath]);
		expect(kept.sort()).toEqual([
			[ID, LIVE, `${FOLDER}/${ID}.conflict-1700-2.json`],
			[ID, LIVE, `${FOLDER}/${ID}.conflict-1700.json`],
		]);
		expect(found.filter((r) => r.outgoingPath !== LIVE), "the adoption pair is no longer listed").toHaveLength(1);
	});

	it("needs a decision only when the copy holds ink the live page lacks", async () => {
		const copy = `${FOLDER}/${ID}.conflict-1700.json`;
		const covered = new Map([
			[LIVE, bytes(["a", "b"])],
			[copy, bytes(["a"])],
		]);
		const [rec] = await scanForForks(host(covered), FOLDER);
		expect((await describeFork(host(covered), rec!)).needsDecision, "a copy the live page already holds asks a question").toBe(false);

		const extra = new Map([
			[LIVE, bytes(["a", "b"])],
			[copy, bytes(["a", "c"])],
		]);
		const [rec2] = await scanForForks(host(extra), FOLDER);
		expect((await describeFork(host(extra), rec2!)).needsDecision, "ink only the copy holds is not put to the user").toBe(true);
	});

	it("keeping this device's ink writes nothing, leaves the live page where it is, and marks only the copy decided", async () => {
		const copy = `${FOLDER}/${ID}.conflict-1700.json`;
		const files = new Map([
			[LIVE, bytes(["mine"])],
			[copy, bytes(["theirs"])],
		]);
		const h = host(files);
		const [rec] = await scanForForks(h, FOLDER);
		const out = await applyForkDecision(h, rec!, "keep-mine");
		expect(out).toMatchObject({ kind: "applied", wrote: false, stillListed: false });
		expect(h.writes, "keeping this device's ink rewrote the live page").toBe(0);
		expect(h.renames, "a decision renamed something other than the copy").toEqual([
			[copy, `${FOLDER}/${ID}.conflict-resolved-1700.json`],
		]);
		expect(parsePage(files.get(LIVE)!, ID).data.strokes.map((s) => s.id)).toEqual(["mine"]);
		expect(await scanForForks(h, FOLDER), "a decided copy is listed again").toEqual([]);
	});

	it("taking the other revision writes it live, and the copy is marked decided under a name no scan lists", async () => {
		const copy = `${FOLDER}/${ID}.conflict-1700-2.json`;
		const files = new Map([
			[LIVE, bytes(["mine"])],
			[copy, bytes(["theirs"])],
		]);
		const h = host(files);
		const [rec] = await scanForForks(h, FOLDER);
		const out = await applyForkDecision(h, rec!, "take-theirs");
		expect(out).toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(parsePage(files.get(LIVE)!, ID).data.strokes.map((s) => s.id)).toEqual(["theirs"]);
		expect(h.renames).toEqual([[copy, `${FOLDER}/${ID}.conflict-resolved-1700-2.json`]]);
		expect(await scanForForks(h, FOLDER)).toEqual([]);
	});
});
