/**
 * A background flush carrier is removed only by the save that made its
 * snapshot durable, never by an older save that happens to land after it.
 *
 * The ordering: normal save A is in flight with its own captured page. More
 * ink makes B; backgrounding dispatches B straight to `<final>.flush`, outside
 * the page chain, and that write completes while A is still in flight. B's
 * normal write then waits behind A. When A lands, the carrier holds B, which A
 * did not persist. Removing it there leaves A live and no durable B, so a
 * freeze before B's own write lands loses B's strokes.
 *
 * Driven through the real PageStore over the fake adapter, with the page's
 * `.tmp` writes held one at a time so the ordering is exact. The freeze is a
 * fresh store over the files on disk at that moment.
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
/**
 * Each held `.tmp` write, in order; release() lets that one through, fail()
 * rejects it without touching the disk.
 */
let held: Array<{ release: () => void; fail: () => void; reached: Promise<void> }>;

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
		let reached!: () => void;
		const entry = { release, fail, reached: new Promise<void>((r) => (reached = r)) };
		held.push(entry);
		reached();
		return gate.then(() => write(path, data));
	};
}

/** Copy of the disk at this instant, loaded by a fresh store: a freeze and restart. */
async function restartFrom(disk: FakeAdapter): Promise<{ loaded: string[]; onDisk: string[][] }> {
	const frozen = new FakeAdapter();
	for (const [k, v] of disk.files) frozen.files.set(k, v);
	for (const [k, v] of disk.mtimes) frozen.mtimes.set(k, v);
	const next = new PageStore({ vault: { adapter: frozen } }, ".handwriting");
	const loaded = await next.load("p1");
	const onDisk = [...frozen.files.entries()]
		.filter(([k]) => k.startsWith(".handwriting/p1."))
		.map(([, v]) => idsIn(v));
	return { loaded: loaded?.data.strokes.map((s) => s.id) ?? [], onDisk };
}

async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

beforeEach(() => {
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	held = [];
});

afterEach(() => {
	for (const h of held) h.release();
});

describe("a flush carrier survives an older save that lands after it", () => {
	it("save A in flight, carrier B written, A lands: B is still on disk and a fresh store can recover it", async () => {
		fake.files.set(LIVE, serializePage(pageWith("a0")));
		fake.mtimes.set(LIVE, ++fake.clock);
		const store = new PageStore({ vault: { adapter: fake } }, ".handwriting");
		await store.load("p1");
		holdTmpWrites();

		// Normal save A consumes its pending entry and waits at its .tmp write.
		const saveA = store.saveNow("p1", pageWith("a0", "a1"));
		await settle();
		expect(held, "precondition: A's .tmp write is in flight").toHaveLength(1);

		// B is drawn; backgrounding writes B's carrier, which lands at once.
		store.schedule("p1", pageWith("a0", "a1", "b1"));
		store.flushDispatch();
		await settle();
		expect(idsIn(fake.files.get(CARRIER)), "precondition: the carrier holds B").toEqual(["a0", "a1", "b1"]);

		// A lands; B's normal write is still waiting behind it.
		held[0]!.release();
		await saveA;
		await settle();
		expect(idsIn(fake.files.get(LIVE)), "precondition: A is live").toEqual(["a0", "a1"]);
		expect(held.length, "precondition: B's own .tmp write has not landed").toBeLessThanOrEqual(2);
		expect(fake.files.get(TMP) === undefined || !idsIn(fake.files.get(TMP)).includes("b1")).toBe(true);

		// Freeze now: what is on disk is all there is. The carrier was built on
		// the bytes before A, so a fresh load keeps it aside as a conflict copy
		// rather than promoting it over A (the base-stamp rule); B is then in that
		// file.
		expect.soft(idsIn(fake.files.get(CARRIER)), "A's completion removed the carrier holding B").toEqual(["a0", "a1", "b1"]);
		const frozen = new FakeAdapter();
		for (const [k, v] of fake.files) frozen.files.set(k, v);
		for (const [k, v] of fake.mtimes) frozen.mtimes.set(k, v);
		const next = new PageStore({ vault: { adapter: frozen } }, ".handwriting");
		const loaded = await next.load("p1");
		const onDisk = [...frozen.files.entries()]
			.filter(([k]) => k.startsWith(".handwriting/p1."))
			.map(([, v]) => idsIn(v));
		expect(
			(loaded?.data.strokes.map((s) => s.id) ?? []).includes("b1") || onDisk.some((ids) => ids.includes("b1")),
			"B's strokes are in no file after a restart"
		).toBe(true);
	});

	it("control: B's own save removes the carrier once B is live", async () => {
		fake.files.set(LIVE, serializePage(pageWith("a0")));
		fake.mtimes.set(LIVE, ++fake.clock);
		const store = new PageStore({ vault: { adapter: fake } }, ".handwriting");
		await store.load("p1");
		holdTmpWrites();

		const saveA = store.saveNow("p1", pageWith("a0", "a1"));
		await settle();
		store.schedule("p1", pageWith("a0", "a1", "b1"));
		store.flushDispatch();
		await settle();
		held[0]!.release();
		await saveA;
		await settle();
		// B's normal write reaches its .tmp and lands.
		for (let i = 0; i < 20 && held.length < 2; i++) await settle();
		expect(held, "precondition: B's normal write reached its .tmp").toHaveLength(2);
		held[1]!.release();
		await settle();
		await store.flushPage("p1");
		expect(idsIn(fake.files.get(LIVE))).toEqual(["a0", "a1", "b1"]);
		expect(fake.files.has(CARRIER), "a carrier outlived the save that made it durable").toBe(false);
	});

	it("control: a newer snapshot C that lands removes an older carrier B", async () => {
		fake.files.set(LIVE, serializePage(pageWith("a0")));
		fake.mtimes.set(LIVE, ++fake.clock);
		const store = new PageStore({ vault: { adapter: fake } }, ".handwriting");
		await store.load("p1");
		store.schedule("p1", pageWith("a0", "b1"));
		store.flushDispatch();
		store.schedule("p1", pageWith("a0", "b1", "c1"));
		await settle();
		await store.flushPage("p1");
		await settle();
		expect(idsIn(fake.files.get(LIVE))).toEqual(["a0", "b1", "c1"]);
		expect(fake.files.has(CARRIER)).toBe(false);
	});
});

describe("a failed older save, retried, does not take a newer carrier's generation", () => {
	// A is consumed and waits at its .tmp write. B's carrier lands and B's
	// normal write queues behind A. A fails; `pending` is empty, so the failure
	// path requeues A. B fails too, after a flushPage has consumed the requeued
	// A as A2. A2 lands. A2's payload never held b1, so it must not remove the
	// carrier that is b1's only durable copy.
	it("A fails, B fails, A's retry lands: B's carrier is still on disk and a fresh store can recover b1", async () => {
		fake.files.set(LIVE, serializePage(pageWith("a0")));
		fake.mtimes.set(LIVE, ++fake.clock);
		const store = new PageStore({ vault: { adapter: fake } }, ".handwriting");
		await store.load("p1");
		holdTmpWrites();

		const saveA = store.saveNow("p1", pageWith("a0", "a1"));
		await settle();
		expect(held, "precondition: A's .tmp write is in flight").toHaveLength(1);

		store.schedule("p1", pageWith("a0", "a1", "b1"));
		store.flushDispatch();
		await settle();
		expect(idsIn(fake.files.get(CARRIER)), "precondition: the carrier holds B").toEqual(["a0", "a1", "b1"]);

		// A fails and is requeued; B's normal write starts and waits at its .tmp.
		held[0]!.fail();
		await saveA;
		for (let i = 0; i < 20 && held.length < 2; i++) await settle();
		expect(held, "precondition: B's .tmp write is in flight").toHaveLength(2);

		// The requeued A is consumed as A2 and queues behind B.
		const retryA = store.flushPage("p1");
		await settle();

		// B fails and is requeued; A2 reaches its .tmp and lands.
		held[1]!.fail();
		for (let i = 0; i < 20 && held.length < 3; i++) await settle();
		expect(held, "precondition: A2's .tmp write is in flight").toHaveLength(3);
		held[2]!.release();
		await retryA;
		await settle();
		expect(idsIn(fake.files.get(LIVE)), "precondition: A2 is live").toEqual(["a0", "a1"]);
		expect(held, "precondition: B's retry has not started").toHaveLength(3);

		// Freeze before B retries.
		expect.soft(idsIn(fake.files.get(CARRIER)), "A2's completion removed the carrier holding b1").toEqual(["a0", "a1", "b1"]);
		const { loaded, onDisk } = await restartFrom(fake);
		expect(
			loaded.includes("b1") || onDisk.some((ids) => ids.includes("b1")),
			"b1 is in no file after a restart"
		).toBe(true);

		// Control: B's own retry lands, and it removes the carrier it covers.
		const retryB = store.flushPage("p1");
		for (let i = 0; i < 20 && held.length < 4; i++) await settle();
		expect(held, "precondition: B's retry reached its .tmp").toHaveLength(4);
		held[3]!.release();
		await retryB;
		await settle();
		expect(idsIn(fake.files.get(LIVE))).toEqual(["a0", "a1", "b1"]);
		expect(fake.files.has(CARRIER), "B's retry landed and left the carrier it made durable").toBe(false);
	});
});

describe("an older save held for an ink-folder move does not take a newer carrier's generation", () => {
	// The same loss as the failed-retry case, through the folder-move door.
	// X is in flight; A is consumed and waits behind X; B's carrier lands and
	// B waits behind A. The folder move starts. X lands; A reaches writeNow,
	// is held for the move and goes back into `pending`; B is held too, but
	// `pending` already holds A, so b1 is now only in the carrier. After the
	// move, A's retry lands. A never held b1, so it must not remove the
	// carrier.
	it("A held for the move, retried after it: B's carrier is still on disk and a fresh store can recover b1", async () => {
		fake.files.set(LIVE, serializePage(pageWith("a0")));
		fake.mtimes.set(LIVE, ++fake.clock);
		const store = new PageStore({ vault: { adapter: fake } }, ".handwriting");
		await store.load("p1");
		holdTmpWrites();

		const saveX = store.saveNow("p1", pageWith("a0", "a1"));
		await settle();
		expect(held, "precondition: X's .tmp write is in flight").toHaveLength(1);
		const saveA = store.saveNow("p1", pageWith("a0", "a1", "a2"));
		await settle();

		store.schedule("p1", pageWith("a0", "a1", "a2", "b1"));
		store.flushDispatch();
		await settle();
		expect(idsIn(fake.files.get(CARRIER)), "precondition: the carrier holds B").toEqual(["a0", "a1", "a2", "b1"]);

		// The move starts; X lands; A and then B reach writeNow and are held.
		store.holdWrites();
		held[0]!.release();
		await saveX;
		await saveA;
		await settle();
		expect(idsIn(fake.files.get(LIVE)), "precondition: X is live").toEqual(["a0", "a1"]);
		expect(held, "precondition: neither A nor B reached its .tmp").toHaveLength(1);

		// The move ends; A's retry reaches its .tmp and lands.
		store.releaseWrites();
		const retryA = store.flushPage("p1");
		for (let i = 0; i < 20 && held.length < 2; i++) await settle();
		expect(held, "precondition: A's retry reached its .tmp").toHaveLength(2);
		held[1]!.release();
		await retryA;
		await settle();
		expect(idsIn(fake.files.get(LIVE)), "precondition: A is live").toEqual(["a0", "a1", "a2"]);

		expect.soft(idsIn(fake.files.get(CARRIER)), "A's held retry removed the carrier holding b1").toEqual([
			"a0",
			"a1",
			"a2",
			"b1",
		]);
		const { loaded, onDisk } = await restartFrom(fake);
		expect(
			loaded.includes("b1") || onDisk.some((ids) => ids.includes("b1")),
			"b1 is in no file after a restart"
		).toBe(true);
	});
});
