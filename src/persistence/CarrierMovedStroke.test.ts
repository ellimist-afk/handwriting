import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Notices captured through the real `obsidian` binding, as CarrierRecoverNotice.test.ts does. */
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
import { PageStore } from "./PageStore";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";
import { bindRecoveryNotices } from "../main";

/**
 * A background flush carrier is promoted over the live page when it holds
 * every stroke id the live page has. Moving a stroke changes its points and
 * keeps its id, so the id test cannot tell a carrier that holds a LATER edit
 * of the live page from a carrier built on OLDER bytes than a move that
 * synced in while the app was stopped.
 *
 * The first describe is the finding: a carrier left by a killed app, and a
 * stroke moved on another device and synced in, so the live page is the newer
 * one. The controls are the two cases a fix must keep: the page's own
 * in-flight save landed and the carrier holds a later move, and a carrier
 * built on exactly the live bytes.
 *
 * The real PageStore over the fake adapter, the real bindRecoveryNotices from
 * main.ts, and a fresh store over the frozen files for the restart.
 */

const LIVE = ".handwriting/p1.json";
const TMP = `${LIVE}.tmp`;

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

/**
 * A store loads `live`, then backgrounding writes a carrier for `carrierPage`
 * while its own save is held. Returns the files as the app was killed.
 */
async function carrierLeftByAKilledApp(live: PageData, carrierPage: PageData): Promise<FakeAdapter> {
	fake.files.set(LIVE, serializePage(live));
	fake.mtimes.set(LIVE, ++fake.clock);
	const store = new PageStore({ vault: { adapter: fake } }, ".handwriting");
	await store.load("p1");
	holdTmpWrites();
	store.schedule("p1", carrierPage);
	store.flushDispatch();
	await settle();
	expect(fake.files.has(`${LIVE}.flush`), "precondition: the carrier is on disk").toBe(true);
	expect(shape(fake.files.get(LIVE)), "precondition: the carrier's own save has not landed").toEqual(shape(serializePage(live)));
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

describe("a flush carrier left by a killed app, and a stroke moved on another device", () => {
	it("a carrier built on older bytes does not roll back a stroke that synced in moved: the live page stands, the carrier is kept aside and named", async () => {
		// Device B drew L while offline and was killed after writing the carrier. The page it was built on had S at 0.
		const frozen = await carrierLeftByAKilledApp(pageWith(["S", 0]), pageWith(["S", 0], ["L", 50]));
		// Device A moved S to 100 and saved; the new page synced in while B's app was stopped.
		frozen.files.set(LIVE, serializePage(pageWith(["S", 100])));
		frozen.mtimes.set(LIVE, ++frozen.clock);
		const loaded = await restart(frozen);
		expect(loaded?.data.strokes.map((s) => `${s.id}@${s.points[0]!.x}`), "the synced move was rolled back to the carrier's old geometry").toEqual(["S@100"]);
		expect(shape(frozen.files.get(LIVE)), "the live file was replaced by the carrier's page").toEqual(["S@100"]);
		const aside = [...frozen.files.keys()].filter((k) => k.includes(".flush-conflict-"));
		expect(aside, "the carrier was not kept aside").toHaveLength(1);
		expect(shape(frozen.files.get(aside[0]!))).toEqual(["S@0", "L@50"]);
		expect([...frozen.files.keys()].filter((k) => k.includes(".superseded-")), "the live page was superseded").toEqual([]);
		expect(frozen.files.has(`${LIVE}.flush`)).toBe(false);
		expect(notices.messages, "the kept copy was not named").toEqual([
			`Handwriting found ink on "Budget" from a save that was cut off. It does not match the saved page, so the page was left as it was. That ink is kept as ${aside[0]}`,
		]);
	});
});

describe("controls: a carrier that is the successor of the live page is still promoted", () => {
	it("the page's own in-flight save landed, and the carrier holds a later move of the same stroke: promoted, the move shows", async () => {
		// Live page P holds S at 0. Save A (adds a1) is in flight; the user then moves S, so backgrounding
		// writes carrier B (S at 100, a1, b1) built on P's bytes; A lands; the app is killed before B's own save.
		fake.files.set(LIVE, serializePage(pageWith(["S", 0])));
		fake.mtimes.set(LIVE, ++fake.clock);
		const store = new PageStore({ vault: { adapter: fake } }, ".handwriting");
		await store.load("p1");
		holdTmpWrites();
		const saveA = store.saveNow("p1", pageWith(["S", 0], ["a1", 20]));
		await settle();
		store.schedule("p1", pageWith(["S", 100], ["a1", 20], ["b1", 60]));
		store.flushDispatch();
		await settle();
		held[0]!();
		await saveA;
		await settle();
		expect(shape(fake.files.get(LIVE)), "precondition: A is live").toEqual(["S@0", "a1@20"]);
		expect(fake.files.has(`${LIVE}.flush`), "precondition: the carrier holding B survived A").toBe(true);
		const frozen = freeze(fake);
		const loaded = await restart(frozen);
		expect(loaded?.data.strokes.map((s) => `${s.id}@${s.points[0]!.x}`), "the later move was not promoted").toEqual(["S@100", "a1@20", "b1@60"]);
		expect(shape(frozen.files.get(LIVE))).toEqual(["S@100", "a1@20", "b1@60"]);
		expect([...frozen.files.keys()].filter((k) => k.includes(".flush-conflict-")), "the later edit was kept aside").toEqual([]);
		const superseded = [...frozen.files.keys()].filter((k) => k.includes(".superseded-"));
		expect(superseded, "the replaced live page was not kept").toHaveLength(1);
		expect(shape(frozen.files.get(superseded[0]!))).toEqual(["S@0", "a1@20"]);
		expect(notices.messages).toEqual([
			`Handwriting restored ink on "Budget" from a save that was cut off. The page as it was before is kept as ${superseded[0]}`,
		]);
	});

	it("a carrier built on exactly the live bytes that moves a stroke is promoted", async () => {
		const frozen = await carrierLeftByAKilledApp(pageWith(["S", 0]), pageWith(["S", 100]));
		const loaded = await restart(frozen);
		expect(loaded?.data.strokes.map((s) => `${s.id}@${s.points[0]!.x}`), "the carrier's move was not promoted").toEqual(["S@100"]);
		expect([...frozen.files.keys()].filter((k) => k.includes(".flush-conflict-"))).toEqual([]);
		expect([...frozen.files.keys()].filter((k) => k.includes(".superseded-"))).toHaveLength(1);
	});
});

/**
 * The carrier names the saves in flight when it was written (`flushInFlight`).
 * What it cannot say keeps the containment rule: a carrier from an older build
 * has no list, and a save whose bytes were not known yet is a null entry. A
 * list that names no live bytes over a page that holds every stroke id is not
 * enough: those bytes came from elsewhere.
 */

/** The first control's files: the page's own save A landed after carrier B was written; the app is then killed. */
async function ownSaveLandedThenKilled(): Promise<FakeAdapter> {
	fake.files.set(LIVE, serializePage(pageWith(["S", 0])));
	fake.mtimes.set(LIVE, ++fake.clock);
	const store = new PageStore({ vault: { adapter: fake } }, ".handwriting");
	await store.load("p1");
	holdTmpWrites();
	const saveA = store.saveNow("p1", pageWith(["S", 0], ["a1", 20]));
	await settle();
	store.schedule("p1", pageWith(["S", 100], ["a1", 20], ["b1", 60]));
	store.flushDispatch();
	await settle();
	held[0]!();
	await saveA;
	await settle();
	expect(shape(fake.files.get(LIVE)), "precondition: A is live").toEqual(["S@0", "a1@20"]);
	expect(fake.files.has(`${LIVE}.flush`), "precondition: the carrier holding B survived A").toBe(true);
	return freeze(fake);
}

/** Rewrite the carrier's saves-in-flight list as `list` says; undefined takes the field away. */
function setInFlight(frozen: FakeAdapter, list: Array<string | null> | undefined): void {
	const raw = JSON.parse(frozen.files.get(`${LIVE}.flush`)!) as Record<string, unknown>;
	const next: Record<string, unknown> = { flushBase: raw.flushBase };
	if (list !== undefined) next.flushInFlight = list;
	next.page = raw.page;
	frozen.files.set(`${LIVE}.flush`, JSON.stringify(next));
}

describe("what a carrier says about the saves in flight when it was written", () => {
	it("a carrier with no list, as an older build writes, over the page's own landed save: promoted", async () => {
		const frozen = await ownSaveLandedThenKilled();
		setInFlight(frozen, undefined);
		const loaded = await restart(frozen);
		expect(loaded?.data.strokes.map((s) => `${s.id}@${s.points[0]!.x}`), "a carrier that cannot say was not promoted").toEqual(["S@100", "a1@20", "b1@60"]);
		expect(shape(frozen.files.get(LIVE))).toEqual(["S@100", "a1@20", "b1@60"]);
		expect([...frozen.files.keys()].filter((k) => k.includes(".flush-conflict-")), "the later edit was kept aside").toEqual([]);
		expect([...frozen.files.keys()].filter((k) => k.includes(".superseded-"))).toHaveLength(1);
	});

	it("a carrier whose list holds a save with bytes not known yet, over the page's own landed save: promoted", async () => {
		const frozen = await ownSaveLandedThenKilled();
		setInFlight(frozen, [null]);
		const loaded = await restart(frozen);
		expect(loaded?.data.strokes.map((s) => `${s.id}@${s.points[0]!.x}`), "a carrier with an unknown save was not promoted").toEqual(["S@100", "a1@20", "b1@60"]);
		expect(shape(frozen.files.get(LIVE))).toEqual(["S@100", "a1@20", "b1@60"]);
		expect([...frozen.files.keys()].filter((k) => k.includes(".flush-conflict-")), "the later edit was kept aside").toEqual([]);
		expect([...frozen.files.keys()].filter((k) => k.includes(".superseded-"))).toHaveLength(1);
	});

	it("a carrier with an empty list, over bytes from elsewhere that keep every stroke id: kept aside, the live page stands", async () => {
		const frozen = await carrierLeftByAKilledApp(pageWith(["S", 0]), pageWith(["S", 0], ["L", 50]));
		setInFlight(frozen, []);
		frozen.files.set(LIVE, serializePage(pageWith(["S", 100])));
		frozen.mtimes.set(LIVE, ++frozen.clock);
		const loaded = await restart(frozen);
		expect(loaded?.data.strokes.map((s) => `${s.id}@${s.points[0]!.x}`), "bytes no save of this page wrote were replaced").toEqual(["S@100"]);
		expect(shape(frozen.files.get(LIVE))).toEqual(["S@100"]);
		const aside = [...frozen.files.keys()].filter((k) => k.includes(".flush-conflict-"));
		expect(aside, "the carrier was not kept aside").toHaveLength(1);
		expect(shape(frozen.files.get(aside[0]!))).toEqual(["S@0", "L@50"]);
		expect([...frozen.files.keys()].filter((k) => k.includes(".superseded-"))).toEqual([]);
	});
});

/**
 * The writer side of the list: each save records the stamp of the bytes it
 * will write, and a save that has finished leaves the list. The cells above
 * rewrite the list by hand, so they cannot see either half.
 */
describe("what the saves-in-flight list holds when a carrier is written", () => {
	it("a save in flight is named by its stamp, so a carrier over bytes from elsewhere that keep every stroke id is kept aside", async () => {
		fake.files.set(LIVE, serializePage(pageWith(["S", 0])));
		fake.mtimes.set(LIVE, ++fake.clock);
		const store = new PageStore({ vault: { adapter: fake } }, ".handwriting");
		await store.load("p1");
		holdTmpWrites();
		void store.saveNow("p1", pageWith(["S", 0], ["a1", 20]));
		await settle();
		store.schedule("p1", pageWith(["S", 0], ["a1", 20], ["b1", 60]));
		store.flushDispatch();
		await settle();
		const carrier = JSON.parse(fake.files.get(`${LIVE}.flush`)!) as { flushInFlight?: unknown };
		expect(carrier.flushInFlight, "the carrier does not name the one save in flight").toHaveLength(1);
		expect((carrier.flushInFlight as unknown[])[0], "the save in flight has no stamp").toEqual(expect.any(String));

		// Another device moved S, and those bytes synced in while the app was stopped.
		const frozen = freeze(fake);
		frozen.files.set(LIVE, serializePage(pageWith(["S", 100])));
		frozen.mtimes.set(LIVE, ++frozen.clock);
		const loaded = await restart(frozen);
		expect(loaded?.data.strokes.map((s) => `${s.id}@${s.points[0]!.x}`), "bytes no save of this page wrote were replaced").toEqual(["S@100"]);
		expect([...frozen.files.keys()].filter((k) => k.includes(".flush-conflict-")), "the carrier was not kept aside").toHaveLength(1);
	});

	it("saves that finished leave the list: a carrier written after them names none", async () => {
		fake.files.set(LIVE, serializePage(pageWith(["S", 0])));
		fake.mtimes.set(LIVE, ++fake.clock);
		const store = new PageStore({ vault: { adapter: fake } }, ".handwriting");
		await store.load("p1");
		await store.saveNow("p1", pageWith(["S", 0], ["a1", 20]));
		await store.saveNow("p1", pageWith(["S", 0], ["a1", 20], ["a2", 30]));
		holdTmpWrites();
		store.schedule("p1", pageWith(["S", 0], ["a1", 20], ["a2", 30], ["a3", 40]));
		store.flushDispatch();
		await settle();
		const carrier = JSON.parse(fake.files.get(`${LIVE}.flush`)!) as { flushInFlight?: unknown };
		expect(carrier.flushInFlight, "finished saves are still named in flight").toEqual([]);
	});
});
