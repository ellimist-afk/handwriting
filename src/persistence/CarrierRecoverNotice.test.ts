import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Notices captured through the real `obsidian` binding, as RecoveredAnnouncesTrashRestore.test.ts does. */
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
import { PageStore, contentStamp } from "./PageStore";
import { PageData, READ_SCHEMA_VERSION, emptyPage, parsePage, serializePage } from "../model/PageData";
import { bindRecoveryNotices } from "../main";

/**
 * After a freeze, a flush carrier built on older live bytes is neither lost nor
 * hidden.
 *
 * The race (as CarrierGeneration.test.ts): normal save A is in flight; the
 * user draws on; backgrounding writes carrier B, built on the bytes before A;
 * A lands; the app freezes before B's own save. On restart the live file is A
 * and the carrier's base is not A's stamp.
 *
 * (a) B holds every stroke of A: it was built on that page, so it is promoted
 * and the newest strokes show. (b) B lacks a stroke A has (erased, then more
 * drawn): the live page stands, B is kept aside, and a notice names the copy.
 *
 * The real PageStore over the fake adapter, the real bindRecoveryNotices from
 * main.ts, and a fresh store over the frozen files for the restart.
 */

const LIVE = ".handwriting/p1.json";
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
	return parsePage(text, "p1").data.strokes.map((s) => s.id);
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

/** Run the race, freeze after A lands, and restart on the frozen files. */
async function raceFreezeRestart(a: PageData, b: PageData) {
	fake.files.set(LIVE, serializePage(pageWith("a0")));
	fake.mtimes.set(LIVE, ++fake.clock);
	const store = new PageStore({ vault: { adapter: fake } }, ".handwriting");
	await store.load("p1");
	holdTmpWrites();
	const saveA = store.saveNow("p1", a);
	await settle();
	store.schedule("p1", b);
	store.flushDispatch();
	await settle();
	held[0]!();
	await saveA;
	await settle();
	expect(idsIn(fake.files.get(LIVE)), "precondition: A is live").toEqual(a.strokes.map((s) => s.id));
	expect(fake.files.has(`${LIVE}.flush`), "precondition: the carrier holding B survived A").toBe(true);

	const frozen = new FakeAdapter();
	for (const [k, v] of fake.files) frozen.files.set(k, v);
	for (const [k, v] of fake.mtimes) frozen.mtimes.set(k, v);
	const next = new PageStore({ vault: { adapter: frozen } }, ".handwriting");
	bindRecoveryNotices(next, () => "Budget");
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const loaded = await next.load("p1");
	warn.mockRestore();
	return { frozen, loaded };
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

describe("a flush carrier built on older bytes is promoted or announced after a restart", () => {
	it("(a) the carrier holds every stroke of the live page: it is promoted and the newest strokes show", async () => {
		const { frozen, loaded } = await raceFreezeRestart(pageWith("a0", "a1"), pageWith("a0", "a1", "b1"));
		expect(loaded?.data.strokes.map((s) => s.id), "the restart shows the older page").toEqual(["a0", "a1", "b1"]);
		expect(idsIn(frozen.files.get(LIVE))).toEqual(["a0", "a1", "b1"]);
		const superseded = [...frozen.files.keys()].filter((k) => k.includes(".superseded-"));
		expect(superseded, "the replaced live page was not kept").toHaveLength(1);
		expect(idsIn(frozen.files.get(superseded[0]!))).toEqual(["a0", "a1"]);
		expect(frozen.files.has(`${LIVE}.flush`)).toBe(false);
		expect(notices.messages.join(" "), "a promotion called the replaced page unreadable").not.toContain("unreadable");
		expect(notices.messages, "the promotion was not announced in its own words").toEqual([
			`Handwriting restored ink on "Budget" from a save that was cut off. The page as it was before is kept as ${superseded[0]}`,
		]);
	});

	it("(b) the carrier lacks a stroke of the live page: the page stands, the copy is kept, and a notice names it", async () => {
		const { frozen, loaded } = await raceFreezeRestart(pageWith("a0", "a1"), pageWith("a0", "b1"));
		expect(loaded?.data.strokes.map((s) => s.id), "premise: the live page stands").toEqual(["a0", "a1"]);
		const aside = [...frozen.files.keys()].filter((k) => k.includes(".flush-conflict-"));
		expect(aside, "premise: the carrier was kept aside").toHaveLength(1);
		expect(idsIn(frozen.files.get(aside[0]!))).toEqual(["a0", "b1"]);
		expect(notices.messages, "no notice named the kept copy").toEqual([
			`Handwriting found ink on "Budget" from a save that was cut off. It does not match the saved page, so the page was left as it was. That ink is kept as ${aside[0]}`,
		]);
	});

	it("control: a carrier built on the live bytes, frozen before its own save lands, is promoted and announced the same way", async () => {
		fake.files.set(LIVE, serializePage(pageWith("a0")));
		fake.mtimes.set(LIVE, ++fake.clock);
		const store = new PageStore({ vault: { adapter: fake } }, ".handwriting");
		await store.load("p1");
		holdTmpWrites();
		store.schedule("p1", pageWith("a0", "b1"));
		store.flushDispatch();
		await settle();
		expect(fake.files.has(`${LIVE}.flush`), "precondition: the carrier is on disk").toBe(true);
		expect(idsIn(fake.files.get(LIVE)), "precondition: B's own save has not landed").toEqual(["a0"]);
		const frozen = new FakeAdapter();
		for (const [k, v] of fake.files) frozen.files.set(k, v);
		for (const [k, v] of fake.mtimes) frozen.mtimes.set(k, v);
		const next = new PageStore({ vault: { adapter: frozen } }, ".handwriting");
		bindRecoveryNotices(next, () => "Budget");
		const loaded = await next.load("p1");
		expect(loaded?.data.strokes.map((s) => s.id)).toEqual(["a0", "b1"]);
		expect([...frozen.files.keys()].filter((k) => k.includes(".flush-conflict-"))).toEqual([]);
		const superseded = [...frozen.files.keys()].filter((k) => k.includes(".superseded-"));
		expect(superseded).toHaveLength(1);
		expect(notices.messages).toEqual([
			`Handwriting restored ink on "Budget" from a save that was cut off. The page as it was before is kept as ${superseded[0]}`,
		]);
	});
});

describe("a carrier never replaces a live page written by a newer format", () => {
	// The live page declares a schema newer than this build reads. Its strokes
	// a0 and a1 still decode, and the carrier (built on older bytes) holds
	// a0, a1 and b1. A partial read of a newer format proves no containment:
	// the live bytes and their read-only flag stay, and the carrier's ink is
	// kept aside and named.
	it("live page from a newer format, carrier holding every stroke it can read: live bytes unchanged, still read-only, carrier kept aside", async () => {
		const future = { ...JSON.parse(serializePage(pageWith("a0", "a1"))), schemaVersion: READ_SCHEMA_VERSION + 1 };
		const liveText = JSON.stringify(future);
		fake.files.set(LIVE, liveText);
		fake.mtimes.set(LIVE, ++fake.clock);
		const olderBase = contentStamp(serializePage(pageWith("a0")));
		fake.files.set(
			`${LIVE}.flush`,
			`{"flushBase":${JSON.stringify(olderBase)},"page":${serializePage(pageWith("a0", "a1", "b1"))}}`
		);
		fake.mtimes.set(`${LIVE}.flush`, ++fake.clock);
		expect(idsIn(liveText), "premise: this build reads the newer page's strokes").toEqual(["a0", "a1"]);

		const store = new PageStore({ vault: { adapter: fake } }, ".handwriting");
		bindRecoveryNotices(store, () => "Budget");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const loaded = await store.load("p1");
		warn.mockRestore();

		expect(fake.files.get(LIVE), "the newer-format live page was replaced").toBe(liveText);
		expect(loaded?.futureVersion, "the page lost its read-only flag").toBe(READ_SCHEMA_VERSION + 1);
		expect([...fake.files.keys()].filter((k) => k.includes(".superseded-")), "the live page was superseded").toEqual([]);
		const aside = [...fake.files.keys()].filter((k) => k.includes(".flush-conflict-"));
		expect(aside, "the carrier was not kept aside").toHaveLength(1);
		expect(idsIn(fake.files.get(aside[0]!))).toEqual(["a0", "a1", "b1"]);
		expect(fake.files.has(`${LIVE}.flush`)).toBe(false);
		expect(notices.messages, "a promotion was announced, or the kept copy was not named").toEqual([
			`Handwriting found ink on "Budget" from a save that was cut off. It does not match the saved page, so the page was left as it was. That ink is kept as ${aside[0]}`,
		]);
	});
});
