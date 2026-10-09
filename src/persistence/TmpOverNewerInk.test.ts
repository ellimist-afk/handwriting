/**
 * A LEFTOVER SAVE IS NEVER PUT IN PLACE OF A FILE WHOSE ONLY FAULT IS INK UNDER A KEY THIS BUILD DOES NOT READ.
 *
 * A save writes `<id>.json.tmp` and renames it onto the live file; a crash
 * between the two leaves a complete .tmp. At a cold load, a live file that
 * does not come back whole is damaged, and its own complete .tmp is then
 * promoted in its place while the live bytes are kept aside. A stroke whose
 * points sit only under a key this build does not read also counts as damage,
 * since a newer build most likely wrote it. Promoting over THAT file makes an
 * older save the live page on every synced device, and the newer file is only
 * reachable by hand. Such a file keeps its place and the damage lock holds it;
 * a file that is damaged in any other way is still promoted over as before.
 *
 * Assertions state the CORRECT behaviour: green = no bug, red = bug.
 */
import { describe, expect, it } from "vitest";
import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { parsePage } from "../model/PageData";

const PAGE_ID = "tmp-over-newer-ink";
const PATH = `.handwriting/${PAGE_ID}.json`;
const TMP = `${PATH}.tmp`;

type Raw = Record<string, unknown>;

const base = { tool: "pen", color: "#4b7bec", width: 2, createdAt: 1 };
const READABLE: Raw = { id: "a", ...base, pts: [10, 20, 0.5, 0, 30, 40, 0.5, 8] };
const NEWER_KEY: Raw = { id: "from-newer-build", ...base, ptsv3: "AAECAwQFBgc=" };
const NO_ID: Raw = { ...base, pts: [50, 60, 0.5, 0, 70, 80, 0.5, 8] };
const CORRUPT_POINTS: Raw = { id: "c", ...base, pts: ["a", "b", "c", "d"] };

function file(strokes: Raw[]): string {
	return JSON.stringify({ schemaVersion: 1, pageId: PAGE_ID, surface: "inline", strokes, textBoxes: [], images: [] });
}

/** The interrupted save: complete, readable, and older than the live file. */
const LEFTOVER = file([READABLE]);

function keptAside(adapter: FakeAdapter): string[] {
	return [...adapter.files.keys()].filter((k) => k.includes(".damaged-")).sort();
}

async function coldLoad(live: string) {
	const adapter = new FakeAdapter();
	adapter.externalWrite(PATH, live);
	adapter.externalWrite(TMP, LEFTOVER);
	const store = new PageStore({ vault: { adapter } });
	const recovered: string[] = [];
	store.onRecovered = (_pageId, keptAs) => recovered.push(keptAs);
	const result = await store.load(PAGE_ID);
	return { adapter, store, recovered, result };
}

describe("a leftover save and a live file with ink under an unknown key", () => {
	it("the live file stays in place, the leftover save stays beside it, and the note stays locked", async () => {
		const live = file([READABLE, NEWER_KEY]);
		expect(parsePage(live, PAGE_ID).damaged, "precondition: this build reads the live file as damaged").toBe(true);
		const { adapter, store, recovered, result } = await coldLoad(live);

		expect(adapter.files.get(PATH), "the leftover save was put in place of the newer file").toBe(live);
		expect(adapter.files.get(TMP), "the leftover save was moved or changed").toBe(LEFTOVER);
		expect(keptAside(adapter), "the newer file was kept aside as damaged").toEqual([]);
		expect(recovered, "the note announced a recovery").toEqual([]);
		expect(result?.damaged, "the note is not locked against writing over the newer file").toBe(true);
		expect(result?.damagedPath, "the damaged-ink notice does not name the live file").toBe(PATH);
		expect(result?.damagedKeptAs).toBeUndefined();

		const again = await store.load(PAGE_ID);
		expect(adapter.files.get(PATH), "a second load put the leftover save in place").toBe(live);
		expect(adapter.files.get(TMP), "a second load moved the leftover save").toBe(LEFTOVER);
		expect(again?.damaged).toBe(true);
	});

	it("control: a live file that is damaged in another way is still replaced by its leftover save, and kept", async () => {
		const live = file([READABLE, NO_ID]);
		const { adapter, recovered, result } = await coldLoad(live);

		expect(adapter.files.get(PATH), "the leftover save was not put in place").toBe(LEFTOVER);
		expect(adapter.files.has(TMP), "the leftover save is still beside the page").toBe(false);
		expect(keptAside(adapter).map((p) => adapter.files.get(p)), "the damaged file was not kept").toEqual([live]);
		expect(recovered, "the recovery was not announced once").toHaveLength(1);
		expect(result?.damaged).toBeFalsy();
		expect(result?.damagedKeptAs).toBeTruthy();
	});

	it("a live file with ink under an unknown key AND another fault is still replaced by its leftover save, and kept", async () => {
		const live = file([READABLE, NEWER_KEY, NO_ID]);
		const { adapter, recovered, result } = await coldLoad(live);

		expect(adapter.files.get(PATH), "the leftover save was not put in place").toBe(LEFTOVER);
		expect(keptAside(adapter).map((p) => adapter.files.get(p)), "the damaged file was not kept").toEqual([live]);
		expect(recovered).toHaveLength(1);
		expect(result?.damagedKeptAs).toBeTruthy();
	});

	it("the reason given for the damage reads as before", () => {
		expect(parsePage(file([READABLE, NEWER_KEY]), PAGE_ID).problem).toBe(
			"partly decodable sidecar: strokes 1 with unreadable points"
		);
		expect(parsePage(file([READABLE, CORRUPT_POINTS]), PAGE_ID).problem).toBe(
			"partly decodable sidecar: strokes 1 with unreadable points"
		);
		expect(
			parsePage(file([READABLE, NEWER_KEY, CORRUPT_POINTS]), PAGE_ID).problem,
			"the two kinds of unreadable points are not counted together"
		).toBe("partly decodable sidecar: strokes 2 with unreadable points");
	});
});
