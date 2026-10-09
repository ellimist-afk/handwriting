import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { InlineInkStore } from "../inline/InlineInkStore";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { emptyPage, parsePage, serializePage, type PageData } from "../model/PageData";
import { FakeAdapter, gate } from "./FakeAdapter";
import { PageStore, type LoadResult } from "./PageStore";

const PAGE_ID = "p1";
const LIVE = ".handwriting/p1.json";
const ARMS = ["load", "control"] as const;

function stroke(id: string): InkStroke {
	const x = [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0);
	const points = [
		{ x, y: 3, pressure: 0.5, t: 0 },
		{ x: x + 10, y: 8, pressure: 0.75, t: 8 },
	];
	return { id, tool: "pen", color: "#4b7bec", width: 2, points, bbox: computeBBox(points, 4), createdAt: 17 };
}

function pageWith(...ids: string[]): PageData {
	const page = emptyPage(PAGE_ID);
	page.surface = "inline";
	page.strokes = ids.map(stroke);
	return parsePage(serializePage(page), PAGE_ID).data;
}

function capture<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

let fake: FakeAdapter;
let store: PageStore;
let releases: Array<() => void>;
let heldWrites: Array<Promise<void>>;

function watchAdapter() {
	return {
		exists: vi.spyOn(fake, "exists"),
		stat: vi.spyOn(fake, "stat"),
		read: vi.spyOn(fake, "read"),
		write: vi.spyOn(fake, "write"),
		rename: vi.spyOn(fake, "rename"),
		remove: vi.spyOn(fake, "remove"),
		mkdir: vi.spyOn(fake, "mkdir"),
	};
}

function counts(watches: ReturnType<typeof watchAdapter>) {
	return Object.fromEntries(Object.entries(watches).map(([name, spy]) => [name, spy.mock.calls.length]));
}

function diskPages() {
	// This fixture contains only p1. Keep every live, tmp and retained copy,
	// including its bytes and full parsed data, before asserting safety.
	return [...fake.files].map(([path, bytes]) => {
		const parsed = parsePage(bytes, PAGE_ID);
		return { path, bytes, damaged: parsed.damaged, data: capture(parsed.data) };
	});
}

function evidence(label: string, observation: unknown) {
	const disk = diskPages();
	const record = { label, observation, disk, adapterLog: [...fake.log], writeAttempts: fake.writeAttempts };
	console.info("INKLOSS-CELL " + JSON.stringify(record));
	return disk;
}

function assertCompleteInk(disk: ReturnType<typeof diskPages>, ...ids: string[]) {
	expect.soft(disk.length, "the writer left no complete page").toBeGreaterThan(0);
	for (const page of disk) {
		expect.soft(page.damaged, `damaged retained page ${page.path}`).toBeFalsy();
		expect.soft(page.data.pageId, `wrong identity in ${page.path}`).toBe(PAGE_ID);
	}
	const strokes = disk.flatMap((page) => page.data.strokes);
	for (const expected of pageWith(...ids).strokes) {
		expect.soft(strokes, `complete stroke ${expected.id} is absent from every file`).toContainEqual(expected);
	}
}

async function seed() {
	fake.externalWrite(LIVE, serializePage(pageWith("base")));
	const loaded = await store.load(PAGE_ID);
	expect(loaded?.damaged, "healthy initial baseline").toBeFalsy();
	expect(loaded?.data.strokes).toEqual(pageWith("base").strokes);
	return fake.files.get(LIVE)!;
}

async function until(done: () => boolean, label: string) {
	for (let step = 0; step < 100 && !done(); step++) await vi.advanceTimersByTimeAsync(0);
	expect(done(), `never reached: ${label}`).toBe(true);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	fake = new FakeAdapter();
	store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
	releases = [];
	heldWrites = [];
});

afterEach(async () => {
	try {
		fake.writeGate = null;
		for (const release of releases) release();
		await Promise.all(heldWrites);
		await store.flush();
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	}
});

describe("queued load must not acknowledge an external revision for an older save", () => {
	it.each(ARMS)("%s: failed queued save, external revision, then retry", async (arm) => {
		const original = await seed();
		const originalMtime = fake.mtimes.get(LIVE);
		fake.failWriteTimes = 1;
		await store.saveNow(PAGE_ID, pageWith("base", "mine"));
		expect(fake.writeAttempts, "real failed tmp write").toBe(1);
		expect(store.hasQueuedWrite(PAGE_ID)).toBe(true);
		expect(fake.files.get(LIVE)).toBe(original);

		const external = serializePage(pageWith("base", "other-device"));
		fake.externalWrite(LIVE, external);
		expect(external).not.toBe(original);
		expect(fake.mtimes.get(LIVE)).not.toBe(originalMtime);
		const watches = watchAdapter();
		const before = counts(watches);
		let loaded: LoadResult | null = null;
		if (arm === "load") loaded = await store.load(PAGE_ID);
		const observation = { loaded: capture(loaded), before, after: counts(watches) };
		expect(store.hasQueuedWrite(PAGE_ID), "the load did not settle the write").toBe(true);

		// Do not abort on the bad load: finish the real retry and capture every
		// durable revision before checking either safety observation.
		await vi.advanceTimersByTimeAsync(1501);
		await store.flush();
		const disk = evidence(`queued-${arm}`, observation);
		expect(fake.writeAttempts, "retry actually reached the adapter").toBeGreaterThan(1);
		expect(store.hasQueuedWrite(PAGE_ID)).toBe(false);
		if (arm === "load") {
			expect.soft(observation.loaded?.data.strokes, "queued load must serve memory").toEqual(pageWith("base", "mine").strokes);
			expect.soft(observation.after, "queued load must perform no disk adapter call").toEqual(before);
		}
		assertCompleteInk(disk, "base", "mine", "other-device");
		expect.soft(disk.some((page) => page.bytes === external), "external revision must remain byte-identical").toBe(true);
		expect.soft(parsePage(fake.files.get(LIVE)!, PAGE_ID).data.strokes, "local save must remain durable").toEqual(pageWith("base", "mine").strokes);
	});
});

describe("same-id note rename while the last stroke is queued", () => {
	it.each(ARMS)("%s: reopen then edit after delete/create versus genuine rename", async (arm) => {
		await seed();
		const noteIds = new Map([["n1.md", PAGE_ID]]);
		const inline = new InlineInkStore();
		inline.attachHost({
			readPageId: (path) => noteIds.get(path) ?? null,
			claimId: async (path, proposedId) => ({ pageId: noteIds.get(path) ?? proposedId }),
			loadSidecar: (id) => store.load(id),
			scheduleSidecar: (id, page) => store.schedule(id, page),
			scheduleSidecarNow: (id, page) => store.saveNow(id, page),
			prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing),
			acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
			sidecarChanged: (id) => store.externallyChanged(id),
			hasQueuedWrite: (id) => store.hasQueuedWrite(id),
			panesQuiet: () => true,
			notify: () => {},
		});
		await inline.ensureLoaded("n1.md");
		inline.commit("n1.md", stroke("D0s1"));
		expect(inline.strokes("n1.md")).toEqual(pageWith("base", "D0s1").strokes);
		expect(store.hasQueuedWrite(PAGE_ID)).toBe(true);
		expect(fake.writeAttempts, "still before the 700 ms debounce").toBe(0);
		expect(parsePage(fake.files.get(LIVE)!, PAGE_ID).data.strokes).toEqual(pageWith("base").strokes);

		// main.ts's Markdown delete event calls handleDelete, not remove or
		// handleRename. The recreated note carries the same frontmatter id.
		if (arm === "load") inline.handleDelete("n1.md");
		else inline.handleRename("n1.md", "r1.md");
		noteIds.delete("n1.md");
		noteIds.set("r1.md", PAGE_ID);
		const watches = watchAdapter();
		const before = counts(watches);
		await inline.ensureLoaded("r1.md");
		const reopened = capture(inline.strokes("r1.md"));
		const after = counts(watches);
		expect(inline.pageIdOf("r1.md"), "same carried identity").toBe(PAGE_ID);
		expect(fake.writeAttempts, "reopen still inside the queue window").toBe(0);
		inline.commit("r1.md", stroke("D0s2"));
		expect(store.hasQueuedWrite(PAGE_ID)).toBe(true);
		await vi.advanceTimersByTimeAsync(701);
		await store.flush();
		const session = capture(inline.strokes("r1.md"));
		const disk = evidence(`rename-${arm}`, { reopened, before, after, session, pageId: inline.pageIdOf("r1.md") });
		expect(fake.writeAttempts, "second edit was really saved").toBeGreaterThan(0);
		expect(store.hasQueuedWrite(PAGE_ID)).toBe(false);
		expect.soft(reopened, "reopen must not discard the queued D0s1").toEqual(pageWith("base", "D0s1").strokes);
		expect.soft(after, "queued-page reopen must perform no disk adapter call").toEqual(before);
		expect.soft(session, "both complete strokes must remain visible").toEqual(pageWith("base", "D0s1", "D0s2").strokes);
		assertCompleteInk(disk, "base", "D0s1", "D0s2");
		expect.soft(parsePage(fake.files.get(LIVE)!, PAGE_ID).data.strokes, "both strokes must survive in the live page").toEqual(pageWith("base", "D0s1", "D0s2").strokes);
	});
});

describe("direct load must not acknowledge external bytes during an in-flight save", () => {
	it.each(ARMS)("%s: held public save, external revision, then write completion", async (arm) => {
		const original = await seed();
		const originalMtime = fake.mtimes.get(LIVE);
		const hold = gate();
		releases.push(hold.release);
		fake.writeGate = hold.promise;
		let settled = false;
		const saving = store.saveNow(PAGE_ID, pageWith("base", "mine")).finally(() => { settled = true; });
		heldWrites.push(saving);
		await until(() => fake.writeAttempts === 1, "held tmp write reached the adapter");
		expect(settled).toBe(false);
		expect(store.hasQueuedWrite(PAGE_ID), "in-flight write is publicly visible").toBe(true);
		expect(fake.files.get(LIVE)).toBe(original);
		const external = serializePage(pageWith("base", "other-device"));
		fake.externalWrite(LIVE, external);
		expect(external).not.toBe(original);
		expect(fake.mtimes.get(LIVE)).not.toBe(originalMtime);
		const watches = watchAdapter();
		const before = counts(watches);
		let loaded: LoadResult | null = null;
		let observation: {
			loaded: LoadResult | null;
			before: ReturnType<typeof counts>;
			after: ReturnType<typeof counts>;
			settledAtLoad: boolean;
			queuedAtLoad: boolean;
		} = { loaded: capture(loaded), before, after: before, settledAtLoad: settled, queuedAtLoad: true };
		try {
			if (arm === "load") loaded = await store.load(PAGE_ID);
			observation = { loaded: capture(loaded), before, after: counts(watches), settledAtLoad: settled, queuedAtLoad: store.hasQueuedWrite(PAGE_ID) };
		} finally {
			// Finally also protects a rejected load; teardown protects any
			// earlier failed premise. Nothing awaits the held write itself.
			fake.writeGate = null;
			hold.release();
		}
		await saving;
		await store.flush();
		const disk = evidence(`in-flight-${arm}`, observation);
		expect(fake.writeAttempts, "the gated write really completed").toBe(1);
		expect(settled).toBe(true);
		expect(store.hasQueuedWrite(PAGE_ID)).toBe(false);
		if (arm === "load") {
			expect.soft(observation.settledAtLoad, "load occurred while the save was in flight").toBe(false);
			expect.soft(observation.queuedAtLoad, "load must keep the in-flight write publicly visible").toBe(true);
			expect.soft(observation.loaded?.data.strokes, "in-flight load must serve memory").toEqual(pageWith("base", "mine").strokes);
			expect.soft(observation.after, "in-flight load must perform no disk adapter call").toEqual(before);
		}
		assertCompleteInk(disk, "base", "mine", "other-device");
		expect.soft(disk.some((page) => page.bytes === external), "external revision must remain byte-identical").toBe(true);
		expect.soft(parsePage(fake.files.get(LIVE)!, PAGE_ID).data.strokes, "local save must remain durable").toEqual(pageWith("base", "mine").strokes);
	});
});

it("a queued save preserves a newer-version file after a second public load", async () => {
	const original = await seed();
	const originalMtime = fake.mtimes.get(LIVE);
	const localPage = pageWith("base", "mine");
	store.schedule(PAGE_ID, localPage);
	expect(store.hasQueuedWrite(PAGE_ID), "the local save is queued").toBe(true);
	expect(fake.writeAttempts, "no timer or write has run").toBe(0);
	expect(fake.files.get(LIVE), "the initial baseline is still on disk").toBe(original);

	const externalPage = pageWith("base", "other-device");
	const futureRaw = JSON.parse(serializePage(externalPage)) as Record<string, unknown>;
	futureRaw.schemaVersion = Number.MAX_SAFE_INTEGER;
	const futureBytes = JSON.stringify(futureRaw);
	const parsedFuture = parsePage(futureBytes, PAGE_ID);
	expect(parsedFuture.futureVersion).toBe(Number.MAX_SAFE_INTEGER);
	expect(parsedFuture.damaged, "the newer schema fixture is not damaged").toBeFalsy();
	expect(parsedFuture.data.strokes, "complete external ink in the fixture").toEqual(externalPage.strokes);
	expect(futureBytes).not.toBe(original);
	fake.externalWrite(LIVE, futureBytes);
	expect(fake.mtimes.get(LIVE)).not.toBe(originalMtime);

	const watches = watchAdapter();
	const before = counts(watches);
	const loaded = await store.load(PAGE_ID);
	const observation = {
		loaded: capture(loaded), before, after: counts(watches),
		queuedAtLoad: store.hasQueuedWrite(PAGE_ID),
		writeAttemptsAtLoad: fake.writeAttempts, liveAtLoad: fake.files.get(LIVE),
		futureBytes, parsedFuture: capture(parsedFuture), localPage: capture(localPage),
	};

	// Finish the real writer and capture every durable page before judging
	// the load or the loss of the future revision.
	await store.flush();
	const disk = evidence("queued-newer-version-public-load", observation);
	expect(fake.writeAttempts, "the scheduled write actually reached the adapter").toBeGreaterThan(0);
	expect(store.hasQueuedWrite(PAGE_ID), "the writer cleared its queue").toBe(false);
	const futureCopies = disk.filter((page) =>
		/^\.handwriting\/p1\.conflict-.*\.json$/.test(page.path) && page.bytes === futureBytes);
	expect.soft(futureCopies.length, "A: an exact future revision must survive in a conflict sibling").toBeGreaterThan(0);
	for (const copy of futureCopies) {
		expect.soft(copy.bytes, "future bytes must be untouched").toBe(futureBytes);
		expect.soft((JSON.parse(copy.bytes) as Record<string, unknown>).schemaVersion,
			"the raw future schema must remain intact").toBe(Number.MAX_SAFE_INTEGER);
	}
	const live = disk.find((page) => page.path === LIVE);
	expect.soft(live?.data, "the complete local page must remain durable").toEqual(localPage);
	assertCompleteInk(disk, "base", "mine", "other-device");

	// Queued-load observations are secondary to the complete durability oracle.
	expect.soft(observation.queuedAtLoad, "load must leave the scheduled write queued").toBe(true);
	expect.soft(observation.writeAttemptsAtLoad, "load must finish before the writer starts").toBe(0);
	expect.soft(observation.loaded?.data.strokes, "queued load must serve complete memory ink").toEqual(localPage.strokes);
	expect.soft(observation.after, "queued load must perform no disk adapter call").toEqual(before);
});
