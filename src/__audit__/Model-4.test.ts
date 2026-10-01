/**
 * AUDIT PROBE Model-4 (read-only audit of 1.4.21, tag 1a05f62c).
 *
 * Claim: a preserved fork pair is written beside the live sidecar, so whatever
 * syncs the live sidecar carries the pair to the OTHER device. There,
 * scanForForks labels the legs from the filename alone: "This device" is the
 * outgoing leg, which is the ADOPTING device's revision, and "Keep this
 * device's ink" writes that revision over the second device's live page.
 *
 * Everything below is production code: two PageStores and two InlineInkStores
 * over two in-memory disks, a real adoption on device A, a byte copy of the
 * files A changed onto device B (what a sync does), and the fork surface on B
 * driven through a ForkHost built exactly as main.ts builds it (main.ts:2502).
 *
 * The assertions state the CORRECT behaviour, so this goes red only if the
 * bug is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore, PageAdapterLike } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { InlineInkStore } from "../inline/InlineInkStore";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";
import {
	FORK_COPY_PLACEHOLDER,
	ForkHost,
	applyForkDecision,
	describeFork,
	forkHostFor,
	listForks,
	refreshForks,
	resetForks,
} from "../persistence/ForkResolution";
import { SYNCED_INK_FOLDER } from "../persistence/InkFolder";

const DEBOUNCE_MS = 700;
const PATH = "note.md";
const PAGE_ID = "p1";
const FOLDER = SYNCED_INK_FOLDER; // "handwriting": the folder a user picks so ink syncs
const LIVE = `${FOLDER}/${PAGE_ID}.json`;

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
	const p = emptyPage(PAGE_ID);
	p.surface = "inline";
	p.strokes = ids.map(stroke);
	return serializePage(p);
}

function idsIn(text: string | undefined): string[] {
	if (text === undefined) return ["<missing>"];
	return parsePage(text, PAGE_ID).data.strokes.map((s) => s.id).sort();
}

interface Device {
	disk: FakeAdapter;
	store: PageStore;
	ink: InlineInkStore;
	/** The install id main.ts gives the store and the fork host; null = none, as before this existed. */
	id: string | null;
}

/** One device: its own disk, PageStore and InlineInkStore, as in the adoption suite. */
function device(disk: FakeAdapter, id: string | null): Device {
	const store = new PageStore({ vault: { adapter: disk as PageAdapterLike } } as never, FOLDER, () => 5_000_000);
	if (id) store.useDeviceId(id);
	const ink = new InlineInkStore();
	ink.attachHost({
		readPageId: (p: string) => (p === PATH ? PAGE_ID : null),
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: (id: string) => store.load(id),
		scheduleSidecar: (id: string, p: PageData) => store.schedule(id, p),
		scheduleSidecarNow: (id: string, p: PageData) => store.saveNow(id, p),
		prepareExternalAdoption: (id: string, outgoing: PageData) => store.prepareExternalAdoption(id, outgoing),
		acceptExternalAdoption: (prepared: never) => store.acceptExternalAdoption(prepared),
		notify: () => {},
	} as never);
	return { disk, store, ink, id };
}

/** The fork host main.ts builds (forkHostFor), over one device's adapter and store, with its install id. */
function forkHost(d: Device): ForkHost {
	return forkHostFor({
		adapter: {
			read: (p) => d.disk.read(p),
			stat: (p) => d.disk.stat(p),
			rename: (from, to) => d.disk.rename(from, to),
			// Obsidian's adapter.list(folder).files: vault-relative paths of the files directly in it.
			list: async (folder) => ({
				files: [...d.disk.files.keys()].filter((k) => k.startsWith(`${folder}/`) && !k.slice(folder.length + 1).includes("/")),
			}),
		},
		store: d.store,
		restoreOpen: async (pageId, data) => (await d.ink.restoreRevision(pageId, data)) !== null,
		...(d.id ? { deviceId: d.id } : {}),
	});
}

async function drain(): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
	for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(0);
}

/** A sync tool delivering one file from one device's disk to the other's. */
function syncFile(from: FakeAdapter, to: FakeAdapter, path: string): void {
	to.externalWrite(path, from.files.get(path)!);
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	resetForks();
});

afterEach(() => {
	vi.useRealTimers();
	resetForks();
});

/**
 * Both devices start from the same synced page; A draws "fromA", B, offline,
 * draws "fromB". B's sidecar syncs to A, A adopts it and preserves the pair,
 * and the pair syncs to B. `idA` / `idB` are the installs' ids; null is an
 * install from before pairs recorded their writer.
 */
async function syncedFork(idA: string | null, idB: string | null) {
	const diskA = new FakeAdapter();
	const diskB = new FakeAdapter();
	for (const disk of [diskA, diskB]) {
		disk.dirs.add(FOLDER);
		disk.externalWrite(LIVE, bytes(["a"]));
	}
	const A = device(diskA, idA);
	await A.ink.ensureLoaded(PATH);
	A.ink.commit(PATH, stroke("fromA"));
	await drain();
	const B = device(diskB, idB);
	await B.ink.ensureLoaded(PATH);
	B.ink.commit(PATH, stroke("fromB"));
	await drain();
	expect(idsIn(diskA.files.get(LIVE))).toEqual(["a", "fromA"]);
	expect(idsIn(diskB.files.get(LIVE))).toEqual(["a", "fromB"]);

	syncFile(diskB, diskA, LIVE);
	const adopted = (await A.ink.adoptExternal(PATH, () => true)) as {
		outcome: string;
		outgoingPath?: string;
		incomingPath?: string;
	};
	expect(adopted.outcome).toBe("adopted");
	const outgoing = adopted.outgoingPath!;
	const incoming = adopted.incomingPath!;
	// Precondition: the pair sits in the synced ink folder, beside the live file.
	expect(outgoing.startsWith(`${FOLDER}/`)).toBe(true);
	expect(incoming.startsWith(`${FOLDER}/`)).toBe(true);
	expect(idsIn(diskA.files.get(outgoing))).toEqual(["a", "fromA"]);
	expect(idsIn(diskA.files.get(incoming))).toEqual(["a", "fromB"]);
	// A's live file is now B's bytes, unchanged: syncing it back to B is a no-op.
	expect(diskA.files.get(LIVE)).toBe(diskB.files.get(LIVE));
	const recA = listForks().find((r) => r.pageId === PAGE_ID)!;

	// The sync carries every file A changed in the synced folder to B.
	syncFile(diskA, diskB, outgoing);
	syncFile(diskA, diskB, incoming);
	return { A, B, diskA, diskB, outgoing, incoming, recA };
}

/** Device B, a different process with an empty register, runs "fix ink de-sync". */
async function scanOnB(B: Device) {
	resetForks();
	const hostB = forkHost(B);
	await refreshForks(hostB, B.store.inkFolder());
	const recB = listForks().find((r) => r.pageId === PAGE_ID);
	expect(recB, "device B must find the synced pair").toBeDefined();
	return { hostB, recB: recB!, accB: await describeFork(hostB, recB!) };
}

describe("Model-4: a synced fork pair on the device that did NOT adopt", () => {
	it("labels this device's revision 'This device', and 'Keep this device's ink' keeps this device's ink", async () => {
		const { A, B, diskA, diskB, recA } = await syncedFork("install-A", "install-B");

		// CONTROL, on the adopting device: the surface is right there.
		const accA = await describeFork(forkHost(A), recA);
		expect(accA.needsDecision).toBe(true);
		expect(idsIn(diskA.files.get(accA.mine.path))).toContain("fromA");

		const { hostB, recB, accB } = await scanOnB(B);
		expect(accB.needsDecision, "the modal lists only needsDecision forks").toBe(true);
		expect(FORK_COPY_PLACEHOLDER.mine).toBe("This device");
		expect(FORK_COPY_PLACEHOLDER.keepMine).toBe("Keep this device's ink");

		// CORRECT BEHAVIOUR 1: the side the modal labels "This device" on B
		// (ForkResolutionModal side(COPY.mine, a.mine, ...)) is B's own revision.
		expect
			.soft(idsIn(diskB.files.get(accB.mine.path)), "on device B, 'This device' must be B's revision")
			.toContain("fromB");

		// CORRECT BEHAVIOUR 2: "Keep this device's ink" on B keeps B's ink.
		const before = diskB.files.get(LIVE);
		expect(idsIn(before)).toEqual(["a", "fromB"]);
		const out = await applyForkDecision(hostB, recB, "keep-mine");
		await drain();
		expect(out.kind).toBe("applied");
		expect(
			idsIn(diskB.files.get(LIVE)),
			"after 'Keep this device's ink' on device B, B's live page must still hold B's stroke"
		).toContain("fromB");
	});

	it("on the adopting device the labels are what they were: a rescan reads the pair as the live record does", async () => {
		const { A, diskA, outgoing, incoming, recA } = await syncedFork("install-A", "install-B");
		expect(recA.outgoingPath).toBe(outgoing);
		// A restart on A: the register is empty and the scan finds the pair.
		resetForks();
		const hostA = forkHost(A);
		await refreshForks(hostA, A.store.inkFolder());
		const rescanned = listForks().find((r) => r.pageId === PAGE_ID)!;
		expect(rescanned.outgoingPath, "'This device' on A is still A's revision").toBe(outgoing);
		expect(rescanned.incomingPath).toBe(incoming);
		const acc = await describeFork(hostA, rescanned);
		expect(idsIn(diskA.files.get(acc.mine.path))).toContain("fromA");
	});

	it("a pair written before pairs recorded their writer reads as it always has: the adopter's view", async () => {
		// A is an older install: its pair carries no writer.
		const { B, diskB, outgoing } = await syncedFork(null, "install-B");
		expect(diskB.files.get(outgoing)).not.toContain("handwriting:adoptedBy");
		const { recB } = await scanOnB(B);
		expect(recB.outgoingPath, "no guessing: the filename's reading stands").toBe(outgoing);
	});
});
