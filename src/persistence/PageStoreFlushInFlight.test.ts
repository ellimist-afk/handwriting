/**
 * Backgrounding while a save waits on an await still leaves a recovery copy of that save's ink.
 *
 * A save takes its batch out of `pending` before its first await (writePending), and the backgrounding flush wrote a
 * recovery copy (the `.flush` carrier) only for what was still in `pending`. A page whose save had left `pending` but not
 * landed had no copy on disk at a freeze, and the next launch found only the older live file. The flush now writes the
 * carrier for such a page too, from the newest attempt still writing; the attempt that carried it removes it when it lands.
 *
 * Driven through the real PageStore over the fake adapter, with the page's `.tmp` writes held one at a time. The freeze is
 * a fresh store over the files on disk at that moment.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "./FakeAdapter";
import { PageStore } from "./PageStore";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";

const LIVE = ".handwriting/p1.json";
const CARRIER = `${LIVE}.flush`;
const TMP = `${LIVE}.tmp`;

function pageWith(...ids: string[]): PageData {
	const p = emptyPage("p1");
	p.surface = "inline";
	p.strokes = ids.map((id) => ({
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 0 },
		createdAt: 0,
	}));
	return p;
}

function idsIn(text: string | undefined): string[] {
	if (text === undefined) return [];
	const raw = JSON.parse(text) as { page?: unknown };
	const page = raw.page !== undefined ? JSON.stringify(raw.page) : text;
	return parsePage(page, "p1").data.strokes.map((s) => s.id);
}

let fake: FakeAdapter;
/** Each held `.tmp` write, in order; release() lets that one through, fail() rejects it without touching the disk. */
let held: Array<{ release: () => void; fail: () => void }>;

function holdTmpWrites(): void {
	const write = fake.write.bind(fake);
	fake.write = (path: string, data: string) => {
		if (path !== TMP) return write(path, data);
		let release!: () => void;
		let fail!: () => void;
		const gate = new Promise<void>((resolve, reject) => {
			release = resolve;
			fail = () => reject(new Error("held .tmp write failed"));
		});
		held.push({ release, fail });
		return gate.then(() => write(path, data));
	};
}

/** Copy of the disk at this instant, loaded by a fresh store: a freeze and restart. */
async function restartFrom(disk: FakeAdapter): Promise<{ loaded: string[]; files: string[] }> {
	const frozen = new FakeAdapter();
	for (const [k, v] of disk.files) frozen.files.set(k, v);
	for (const [k, v] of disk.mtimes) frozen.mtimes.set(k, v);
	const next = new PageStore({ vault: { adapter: frozen } }, ".handwriting");
	const loaded = await next.load("p1");
	return { loaded: loaded?.data.strokes.map((s) => s.id) ?? [], files: [...frozen.files.keys()].sort() };
}

async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

async function storeWithSaveInFlight(): Promise<{ store: PageStore; save: Promise<void> }> {
	fake.files.set(LIVE, serializePage(pageWith("a0")));
	fake.mtimes.set(LIVE, ++fake.clock);
	const store = new PageStore({ vault: { adapter: fake } }, ".handwriting");
	await store.load("p1");
	holdTmpWrites();
	// The save takes its batch out of `pending` and waits at its .tmp write.
	const save = store.saveNow("p1", pageWith("a0", "a1"));
	await settle();
	expect(held, "precondition: the save's .tmp write is in flight").toHaveLength(1);
	return { store, save };
}

beforeEach(() => {
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	held = [];
});

afterEach(() => {
	for (const h of held) h.release();
});

describe("backgrounding while a save waits on an await", () => {
	it("writes a recovery copy of the save's ink, and a freeze before the save lands keeps that ink", async () => {
		const { store } = await storeWithSaveInFlight();
		store.flushDispatch();
		await settle();
		expect(idsIn(fake.files.get(CARRIER)), "the recovery copy holds the ink the save carries").toEqual(["a0", "a1"]);
		const after = await restartFrom(fake);
		expect(after.loaded, "a fresh launch finds the ink the save was carrying").toEqual(["a0", "a1"]);
	});

	it("removes that copy when the save it came from lands, so a later launch keeps no second copy", async () => {
		const { store, save } = await storeWithSaveInFlight();
		store.flushDispatch();
		await settle();
		expect(idsIn(fake.files.get(CARRIER)), "precondition: the copy was written").toEqual(["a0", "a1"]);
		held[0]!.release();
		await save;
		await settle();
		expect(idsIn(fake.files.get(LIVE))).toEqual(["a0", "a1"]);
		expect(fake.files.has(CARRIER), "the copy outlived the save that made its ink durable").toBe(false);
		const after = await restartFrom(fake);
		expect(after.loaded).toEqual(["a0", "a1"]);
		expect(after.files.filter((f) => f.startsWith(".handwriting/p1.") && f !== LIVE), "no kept or superseded copy").toEqual([]);
	});

	it("keeps the copy when that save fails, until its retry lands", async () => {
		const { store, save } = await storeWithSaveInFlight();
		store.flushDispatch();
		await settle();
		held[0]!.fail();
		await save.catch(() => undefined);
		await settle();
		expect(idsIn(fake.files.get(CARRIER)), "the failed save's ink is still on disk").toEqual(["a0", "a1"]);
		expect((await restartFrom(fake)).loaded, "a freeze now keeps it").toEqual(["a0", "a1"]);
		// The retry reaches its .tmp and lands.
		const retry = store.flushPage("p1");
		for (let i = 0; i < 20 && held.length < 2; i++) await settle();
		expect(held, "precondition: the retry reached its .tmp").toHaveLength(2);
		held[1]!.release();
		await retry;
		await settle();
		expect(idsIn(fake.files.get(LIVE))).toEqual(["a0", "a1"]);
		expect(fake.files.has(CARRIER), "the retry that made the ink durable removes the copy").toBe(false);
	});

	it("removes the copy only after its own write has settled, when that write is still going as the save lands", async () => {
		const { store, save } = await storeWithSaveInFlight();
		// The copy's write is slow: it is still going when the save lands.
		const write = fake.write.bind(fake);
		let releaseCarrier!: () => void;
		const carrierGate = new Promise<void>((resolve) => (releaseCarrier = resolve));
		let carrierWrites = 0;
		fake.write = (path: string, data: string) =>
			path === CARRIER ? (carrierWrites++, carrierGate.then(() => write(path, data))) : write(path, data);
		store.flushDispatch();
		await settle();
		expect(carrierWrites, "precondition: the copy's write was dispatched").toBe(1);
		held[0]!.release();
		await settle();
		expect(idsIn(fake.files.get(LIVE)), "precondition: the save has landed").toEqual(["a0", "a1"]);
		releaseCarrier();
		await save;
		await settle();
		expect(fake.files.has(CARRIER), "the remove ran before the copy's write landed, and the copy stayed").toBe(false);
		const after = await restartFrom(fake);
		expect(after.loaded).toEqual(["a0", "a1"]);
		expect(after.files.filter((f) => f.startsWith(".handwriting/p1.") && f !== LIVE), "no kept or superseded copy").toEqual([]);
	});

	it("keeps the copy written from the newer of two saves in flight when the older lands, and the newer removes it", async () => {
		const { store, save } = await storeWithSaveInFlight();
		// A second save is consumed and waits its turn in the page chain behind the first.
		const second = store.saveNow("p1", pageWith("a0", "a1", "a2"));
		await settle();
		store.flushDispatch();
		await settle();
		expect(idsIn(fake.files.get(CARRIER)), "precondition: the copy holds the newer save's ink").toEqual(["a0", "a1", "a2"]);
		held[0]!.release();
		await save;
		await settle();
		expect(idsIn(fake.files.get(LIVE)), "precondition: the older save has landed").toEqual(["a0", "a1"]);
		expect(idsIn(fake.files.get(CARRIER)), "the older save removed the copy of the newer ink").toEqual(["a0", "a1", "a2"]);
		expect((await restartFrom(fake)).loaded, "a freeze now keeps the newer ink").toEqual(["a0", "a1", "a2"]);
		for (let i = 0; i < 20 && held.length < 2; i++) await settle();
		expect(held, "precondition: the newer save reached its .tmp").toHaveLength(2);
		held[1]!.release();
		await second;
		await settle();
		expect(idsIn(fake.files.get(LIVE))).toEqual(["a0", "a1", "a2"]);
		expect(fake.files.has(CARRIER), "the newer save removes its copy when it lands").toBe(false);
	});

	it("control: a page with nothing pending and nothing writing gets no copy", async () => {
		fake.files.set(LIVE, serializePage(pageWith("a0")));
		fake.mtimes.set(LIVE, ++fake.clock);
		const store = new PageStore({ vault: { adapter: fake } }, ".handwriting");
		await store.load("p1");
		store.flushDispatch();
		await settle();
		expect(fake.files.has(CARRIER)).toBe(false);
	});
});
