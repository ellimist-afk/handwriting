/**
 * AUDIT PROBE L-errors-2 (read-only audit of tag 1a05f62c).
 *
 * Claim: while another device writes a note that is open here, every adopted
 * sync revision writes a fresh pair of `.conflict-external-*` recovery files,
 * and nothing ever removes them, so the ink folder grows without bound (and
 * the bytes grow quadratically, since each pair copies the whole, growing page).
 *
 * Drive: the REAL live-reload poll block sliced out of main.ts (via
 * installLiveReloadPoll), a REAL InlineInkStore and a REAL PageStore over an
 * in-memory adapter. The desktop is receive-only: it never draws. The tablet
 * appends one stroke per revision (a strict superset each time).
 *
 * Asserts the CORRECT behaviour: recovery-file count stays bounded (does not
 * grow with the number of revisions delivered). Goes red only if the pairs pile
 * up per revision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { InlineInkStore } from "../inline/InlineInkStore";
import { PageData, emptyPage, serializePage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";
import { installLiveReloadPoll } from "../testUtils/LiveReloadTestHarness";

const DEBOUNCE_MS = 700;
const PATH = "note.md";
const PAGE_ID = "p1";
const LIVE = ".handwriting/p1.json";

function stroke(id: string, n = 40): InkStroke {
	const points = Array.from({ length: n }, (_, k) => ({
		x: 100 + k * 1.37,
		y: 200 + k * 0.91,
		pressure: 0.4 + (k % 10) / 40,
		t: k * 8,
	}));
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points,
		bbox: { x: 100, y: 200, width: 60, height: 40 },
		createdAt: 0,
	};
}

function page(ids: string[]): PageData {
	const p = emptyPage(PAGE_ID);
	p.surface = "inline";
	p.strokes = ids.map((id) => stroke(id));
	return p;
}

let fake: FakeAdapter;

async function drain(): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
	for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(0);
}

function artifacts(): string[] {
	return [...fake.files.keys()].filter((k) => k.includes(".conflict-external-")).sort();
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("L-errors-2: receive-only device adopting a stream of remote revisions", () => {
	it("does not accumulate a new pair of recovery files for every delivered revision", async () => {
		// The desktop opens the note: tablet has already drawn stroke r0.
		fake.externalWrite(LIVE, serializePage(page(["r0"])));

		const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
		const ink = new InlineInkStore();
		let accepts = 0;
		ink.attachHost({
			readPageId: (p: string) => (p === PATH ? PAGE_ID : null),
			claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
			loadSidecar: (id: string) => store.load(id),
			scheduleSidecar: (id: string, p: PageData) => store.schedule(id, p),
			scheduleSidecarNow: (id: string, p: PageData) => store.saveNow(id, p),
			prepareExternalAdoption: (id: string, outgoing: PageData) =>
				store.prepareExternalAdoption(id, outgoing),
			acceptExternalAdoption: (prepared: never) => {
				accepts++;
				store.acceptExternalAdoption(prepared);
			},
			notify: () => {},
		} as never);
		await ink.ensureLoaded(PATH);
		await drain();
		expect(ink.strokes(PATH).map((s) => s.id)).toEqual(["r0"]);
		expect(store.hasQueuedWrite(PAGE_ID)).toBe(false);

		// The REAL poll registration from main.ts.
		let fire!: () => void;
		let pending: Promise<void> = Promise.resolve();
		const painted: string[] = [];
		const host = {
			store,
			pdfInk: new Map(),
			pdfIds: new Map(),
			pdfStore: { reloadExternal: async () => false },
			pollStats: { ticks: 0, hidden: 0, spaced: 0, checks: 0 },
			registerInterval: (h: number) => h,
		};
		installLiveReloadPoll.call(
			host,
			{ setInterval(fn: () => void) { fire = fn; return 1; } },
			{ hidden: false },
			(promise: Promise<void>) => { pending = promise.catch(() => {}); },
			() => [PATH],
			ink,
			(p: string) => painted.push(p),
			() => {},
			() => null,
			async () => false,
			{ error: () => {} },
			(p: string) => (p === PATH ? () => true : null)
		);
		const tick = async () => { fire(); await pending; await drain(); };

		// The tablet delivers N revisions, one stroke more each time. The desktop
		// draws nothing at all.
		const N = 12;
		const ids = ["r0"];
		const history: { rev: number; files: number; bytes: number; live: number }[] = [];
		for (let rev = 1; rev <= N; rev++) {
			ids.push(`r${rev}`);
			fake.externalWrite(LIVE, serializePage(page(ids)));
			await tick();
			// PRECONDITION: the revision really was adopted through the route.
			expect(ink.strokes(PATH).map((s) => s.id), `rev ${rev} not adopted`).toEqual(ids);
			expect(accepts, `rev ${rev} accept count`).toBe(rev);
			const arts = artifacts();
			history.push({
				rev,
				files: arts.length,
				bytes: arts.reduce((a, p) => a + fake.files.get(p)!.length, 0),
				live: fake.files.get(LIVE)!.length,
			});
		}
		// Receive-only: the desktop never wrote the live sidecar itself.
		expect(fake.writes().filter((w) => w === `write ${LIVE}`)).toEqual([]);
		// Nothing was ever removed.
		expect(fake.log.filter((l) => l.startsWith("remove "))).toEqual([]);

		const last = history[history.length - 1]!;
		const summary = history
			.map((h) => `rev${h.rev}: ${h.files} files ${h.bytes}B (live ${h.live}B)`)
			.join(" | ");
		console.log(`[L-errors-2] ${summary}`);

		// CORRECT BEHAVIOUR: the recovery-file count does not scale with the
		// number of remote revisions a receive-only device merely adopted.
		expect(last.files, `recovery files after ${N} adopted revisions: ${summary}`).toBeLessThanOrEqual(2);
	});
});
