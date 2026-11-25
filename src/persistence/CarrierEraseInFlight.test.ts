import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Notices captured through the real `obsidian` binding, as CarrierMovedStroke.test.ts does. */
const notices = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			constructor(message: string) {
				notices.messages.push(message);
			}
		},
	};
});

import { installFakeWindow } from "../../test/routerHarness";
installFakeWindow();

import { FakeAdapter } from "./FakeAdapter";
import { PageStore, contentStamp, newPageWriter } from "./PageStore";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";
import { bindRecoveryNotices } from "../main";

/**
 * A quit or a phone hide while one save of a big ink file is still writing, after an erase.
 *
 * Save D1 is writing. The user erases a stroke, so D2 is queued. Backgrounding writes the carrier from D2,
 * naming D1's stamp among the saves in flight. D1 lands, and the app is killed before D2 does. The next open
 * finds D1 live and the carrier beside it.
 *
 * The carrier names the live bytes' exact stamp: those bytes are a save of this page that left the queue
 * before the carrier's page was composed, so the carrier is the newer page whatever it erased, split or undid.
 * Before this, the carrier also had to hold every stroke id of the live page, so an erase sent it aside and
 * the older save showed with the erased stroke back.
 *
 * Pins kept: a carrier that cannot say which bytes its saves wrote (an older build's carrier with no list, or
 * a save whose bytes were not known yet) still needs every stroke id; bytes no save of this page wrote are never
 * replaced; and a save whose bytes were merged with another writer's file names no stamp, so its carrier falls
 * to the stroke-id test.
 *
 * The real PageStore over the fake adapter, the real bindRecoveryNotices from main.ts, and a fresh store over
 * the frozen files for the restart.
 */

const LIVE = ".handwriting/p1.json";
const TMP = `${LIVE}.tmp`;
const CARRIER = `${LIVE}.flush`;

/** One stroke per id; `x` is where its first point sits, so a move changes the points and not the id. */
function pageWith(...strokes: Array<[id: string, x: number]>): PageData {
	const p = emptyPage("p1");
	p.surface = "inline";
	p.strokes = strokes.map(([id, x]) => ({
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x, y: 0, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x, y: 0, width: 10, height: 0 },
		createdAt: 0,
	}));
	return p;
}

/** Each stroke as `id@x`, in page order. */
function shape(text: string | undefined): string[] {
	if (text === undefined) return [];
	return parsePage(text, "p1").data.strokes.map((s) => `${s.id}@${s.points[0]!.x}`);
}

let fake: FakeAdapter;
let held: Array<() => void>;

/** Every write of the page's .tmp waits until the test releases it, in order. */
function holdTmpWrites(): void {
	const write = fake.write.bind(fake);
	fake.write = (path: string, data: string) => {
		if (path !== TMP) return write(path, data);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		held.push(release);
		return gate.then(() => write(path, data));
	};
}

async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

function freeze(from: FakeAdapter): FakeAdapter {
	const frozen = new FakeAdapter();
	for (const [k, v] of from.files) frozen.files.set(k, v);
	for (const [k, v] of from.mtimes) frozen.mtimes.set(k, v);
	frozen.clock = from.clock;
	return frozen;
}

async function restart(frozen: FakeAdapter) {
	const next = new PageStore({ vault: { adapter: frozen } }, ".handwriting");
	bindRecoveryNotices(next, () => "Budget");
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const loaded = await next.load("p1");
	warn.mockRestore();
	return loaded;
}

function carrierInFlight(files: FakeAdapter): unknown {
	return (JSON.parse(files.files.get(CARRIER)!) as { flushInFlight?: unknown }).flushInFlight;
}

/** Rewrite the carrier's saves-in-flight list as `list` says; undefined takes the field away, as an older build writes it. */
function setInFlight(frozen: FakeAdapter, list: Array<string | null> | undefined): void {
	const raw = JSON.parse(frozen.files.get(CARRIER)!) as Record<string, unknown>;
	const next: Record<string, unknown> = { flushBase: raw.flushBase };
	if (list !== undefined) next.flushInFlight = list;
	next.page = raw.page;
	frozen.files.set(CARRIER, JSON.stringify(next));
}

const kept = (files: FakeAdapter, kind: string) => [...files.files.keys()].filter((k) => k.includes(`.${kind}-`));

/**
 * D0 is live and loaded. Save D1 is held after its bytes and stamp are made; D2 is queued and backgrounding
 * writes the carrier from it; D1 lands; D2's own write is still held when the app is killed.
 */
async function killedAfterTheSaveInFlightLanded(d0: PageData, d1: PageData, d2: PageData): Promise<FakeAdapter> {
	fake.files.set(LIVE, serializePage(d0));
	fake.mtimes.set(LIVE, ++fake.clock);
	const store = new PageStore({ vault: { adapter: fake } }, ".handwriting");
	await store.load("p1");
	holdTmpWrites();
	const save1 = store.saveNow("p1", d1);
	await settle();
	expect(held, "precondition: D1's write is held").toHaveLength(1);
	store.schedule("p1", d2);
	store.flushDispatch();
	await settle();
	expect(fake.files.has(CARRIER), "precondition: the carrier is on disk").toBe(true);
	held[0]!();
	await save1;
	await settle();
	expect(shape(fake.files.get(LIVE)), "precondition: D1 is live").toEqual(shape(serializePage(d1)));
	expect(fake.files.has(CARRIER), "precondition: the carrier survived D1").toBe(true);
	const list = carrierInFlight(fake);
	expect(list, "precondition: the carrier names D1's stamp, the live bytes").toEqual([contentStamp(fake.files.get(LIVE)!)]);
	return freeze(fake);
}

beforeEach(() => {
	fake = new FakeAdapter();
	held = [];
	notices.messages.length = 0;
});
afterEach(() => {
	for (const release of held) release();
	vi.restoreAllMocks();
});

describe("a quit mid-save after an erase: the carrier names the live bytes' stamp, so the newest page opens", () => {
	async function promoted(frozen: FakeAdapter, want: string[], replaced: string[]): Promise<void> {
		const loaded = await restart(frozen);
		expect(loaded?.data.strokes.map((s) => `${s.id}@${s.points[0]!.x}`), "the older save opened, not the carrier's newer page").toEqual(want);
		expect(shape(frozen.files.get(LIVE)), "the live file is not the carrier's page").toEqual(want);
		expect(kept(frozen, "flush-conflict"), "the newer page was kept aside as a conflict").toEqual([]);
		const superseded = kept(frozen, "superseded");
		expect(superseded, "the replaced live page was not kept").toHaveLength(1);
		expect(shape(frozen.files.get(superseded[0]!)), "the kept copy is not the save that landed").toEqual(replaced);
		expect(frozen.files.has(CARRIER), "the carrier is still on disk").toBe(false);
		expect(notices.messages).toEqual([
			`Handwriting restored ink on "Budget" from a save that was cut off. The page as it was before is kept as ${superseded[0]}`,
		]);
	}

	it("an erase: the stroke stays erased and the stroke drawn last is there", async () => {
		const frozen = await killedAfterTheSaveInFlightLanded(pageWith(["a", 0], ["b", 20]), pageWith(["a", 0], ["b", 20], ["c", 40]), pageWith(["a", 0], ["c", 40]));
		await promoted(frozen, ["a@0", "c@40"], ["a@0", "b@20", "c@40"]);
	});

	it("a partial erase that split a stroke into two new ids: the split opens", async () => {
		const frozen = await killedAfterTheSaveInFlightLanded(
			pageWith(["a", 0], ["b", 20]),
			pageWith(["a", 0], ["b", 20], ["c", 40]),
			pageWith(["a", 0], ["b1", 20], ["b2", 25], ["c", 40])
		);
		await promoted(frozen, ["a@0", "b1@20", "b2@25", "c@40"], ["a@0", "b@20", "c@40"]);
	});

	it("an undo of the stroke the landed save added: the undo holds", async () => {
		const frozen = await killedAfterTheSaveInFlightLanded(pageWith(["a", 0], ["b", 20]), pageWith(["a", 0], ["b", 20], ["c", 40]), pageWith(["a", 0], ["b", 20]));
		await promoted(frozen, ["a@0", "b@20"], ["a@0", "b@20", "c@40"]);
	});
});

describe("pins: a carrier that cannot say, or bytes no save of this page wrote, keep today's rule", () => {
	async function keptAside(frozen: FakeAdapter, live: string[], carrier: string[]): Promise<void> {
		const loaded = await restart(frozen);
		expect(loaded?.data.strokes.map((s) => `${s.id}@${s.points[0]!.x}`), "the live page did not stand").toEqual(live);
		expect(shape(frozen.files.get(LIVE)), "the live file was replaced").toEqual(live);
		const aside = kept(frozen, "flush-conflict");
		expect(aside, "the carrier was not kept aside").toHaveLength(1);
		expect(shape(frozen.files.get(aside[0]!))).toEqual(carrier);
		expect(kept(frozen, "superseded"), "the live page was superseded").toEqual([]);
		expect(frozen.files.has(CARRIER)).toBe(false);
	}

	it("a save whose bytes were not known yet when the carrier was written (a null entry), after an erase: kept aside, the live page stands", async () => {
		const frozen = await killedAfterTheSaveInFlightLanded(pageWith(["a", 0], ["b", 20]), pageWith(["a", 0], ["b", 20], ["c", 40]), pageWith(["a", 0], ["c", 40]));
		setInFlight(frozen, [null]);
		await keptAside(frozen, ["a@0", "b@20", "c@40"], ["a@0", "c@40"]);
	});

	it("an older build's carrier with no list, after an erase: kept aside, the live page stands", async () => {
		const frozen = await killedAfterTheSaveInFlightLanded(pageWith(["a", 0], ["b", 20]), pageWith(["a", 0], ["b", 20], ["c", 40]), pageWith(["a", 0], ["c", 40]));
		setInFlight(frozen, undefined);
		await keptAside(frozen, ["a@0", "b@20", "c@40"], ["a@0", "c@40"]);
	});

	it("the carrier names a save, but the live bytes came from another device that moved a stroke: kept aside, the move stands", async () => {
		const frozen = await killedAfterTheSaveInFlightLanded(pageWith(["a", 0], ["b", 20]), pageWith(["a", 0], ["b", 20], ["c", 40]), pageWith(["a", 0], ["c", 40]));
		frozen.files.set(LIVE, serializePage(pageWith(["a", 100], ["b", 20], ["c", 40])));
		frozen.mtimes.set(LIVE, ++frozen.clock);
		await keptAside(frozen, ["a@100", "b@20", "c@40"], ["a@0", "c@40"]);
	});

	/**
	 * Two writers of one page. A's save lands; B never saw A's stroke b, so B's save is merged with the file and
	 * its bytes hold b, which B's page never had. B's next page is queued and carried, then the app is killed.
	 */
	async function mergedSaveThenKilled(): Promise<FakeAdapter> {
		fake.files.set(LIVE, serializePage(pageWith(["a", 0])));
		fake.mtimes.set(LIVE, ++fake.clock);
		const store = new PageStore({ vault: { adapter: fake } }, ".handwriting");
		await store.load("p1");
		const A = newPageWriter("pane-a");
		const B = newPageWriter("pane-b");
		await store.saveNow("p1", pageWith(["a", 0], ["b", 20]), A);
		await settle();
		holdTmpWrites();
		const saveB = store.saveNow("p1", pageWith(["a", 0], ["c", 40]), B);
		await settle();
		expect(held, "precondition: B's write is held").toHaveLength(1);
		store.schedule("p1", pageWith(["a", 0], ["c", 40], ["d", 60]), B);
		store.flushDispatch();
		await settle();
		held[0]!();
		await saveB;
		await settle();
		expect([...shape(fake.files.get(LIVE))].sort(), "precondition: B's landed bytes are the merge").toEqual(["a@0", "b@20", "c@40"]);
		expect(fake.files.has(CARRIER), "precondition: the carrier survived B's save").toBe(true);
		expect(carrierInFlight(fake), "precondition: the carrier lists the one save in flight").toHaveLength(1);
		return freeze(fake);
	}

	it("a save merged with another writer's file is listed with no stamp: its bytes are not a page this document composed", async () => {
		const frozen = await mergedSaveThenKilled();
		expect(carrierInFlight(frozen), "the merged save named its stamp").toEqual([null]);
	});

	it("so a carrier written during a merged save, which lacks the merged-in stroke, is kept aside", async () => {
		const frozen = await mergedSaveThenKilled();
		const loaded = await restart(frozen);
		expect([...(loaded?.data.strokes.map((s) => `${s.id}@${s.points[0]!.x}`) ?? [])].sort(), "the merged-in stroke was lost").toEqual(["a@0", "b@20", "c@40"]);
		expect(kept(frozen, "flush-conflict"), "the carrier was not kept aside").toHaveLength(1);
		expect(kept(frozen, "superseded")).toEqual([]);
	});
});
