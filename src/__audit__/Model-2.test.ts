/**
 * AUDIT PROBE Model-2 (1.4.21, 1a05f62c). Read-only probe; not shipped.
 *
 * Claim: "Keep this device's ink" (applyForkDecision keep-mine,
 * ForkResolution.ts:351) writes the fork-time outgoing capture over the live
 * sidecar through saveNow. Strokes drawn on this device after the fork are in
 * no file afterwards: not the live sidecar, not either artifact, no .conflict
 * copy.
 *
 * Drives the real PageStore + real InlineInkStore.adoptExternal (which records
 * the fork) + real describeFork/applyForkDecision, with host.saveNow wired to
 * store.saveNow exactly as main.ts:2497-2515 does. Asserts the CORRECT outcome
 * (the post-fork stroke still exists in some file on disk), so it reds only if
 * the claimed loss is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { InlineInkStore } from "../inline/InlineInkStore";
import {
	ForkHost,
	applyForkDecision,
	describeFork,
	listForks,
	resetForks,
	forkHostFor,
} from "../persistence/ForkResolution";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";

const DEBOUNCE_MS = 700;
const PATH = "note.md";
const PAGE_ID = "p1";
const LIVE = ".handwriting/p1.json";

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

let fake: FakeAdapter;

async function drain(): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
	for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(0);
}

function device(): { store: PageStore; ink: InlineInkStore } {
	const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
	const ink = new InlineInkStore();
	ink.attachHost({
		readPageId: (p: string) => (p === PATH ? PAGE_ID : null),
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: (id: string) => store.load(id),
		scheduleSidecar: (id: string, p: PageData) => store.schedule(id, p),
		scheduleSidecarNow: (id: string, p: PageData) => store.saveNow(id, p),
		prepareExternalAdoption: (id: string, outgoing: PageData) =>
			store.prepareExternalAdoption(id, outgoing),
		acceptExternalAdoption: (prepared: never) => store.acceptExternalAdoption(prepared),
		notify: () => {},
	} as never);
	return { store, ink };
}

/** Stroke ids in a file, or null if it is not a readable page. */
function idsIn(path: string): string[] | null {
	const text = fake.files.get(path);
	if (text === undefined) return null;
	const parsed = parsePage(text, PAGE_ID);
	const ids = parsed.data.strokes.map((s) => s.id);
	// The outgoing artifact nests an exact capture; include those ids too.
	const nested = (parsed.data.unknownTop as Record<string, unknown> | undefined)?.[
		"handwriting:exactOutgoing"
	] as { strokes?: { id: string }[] } | undefined;
	if (nested?.strokes) ids.push(...nested.strokes.map((s) => s.id));
	return ids;
}

/** Every file on disk that holds the given stroke id, raw-text search as a backstop. */
function filesHolding(id: string): string[] {
	return [...fake.files.entries()]
		.filter(([p, text]) => (idsIn(p) ?? []).includes(id) || text.includes(`"${id}"`))
		.map(([p]) => p)
		.sort();
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	resetForks();
});

afterEach(() => {
	vi.useRealTimers();
	resetForks();
});

describe("Model-2: keep-mine after post-fork drawing", () => {
	it("keeps strokes drawn on this device after the fork somewhere on disk", async () => {
		// 1. Device A, loaded and settled, live = [a, local].
		fake.files.set(LIVE, bytes(["a"]));
		fake.mtimes.set(LIVE, ++fake.clock);
		const a = device();
		await a.ink.ensureLoaded(PATH);
		a.ink.commit(PATH, stroke("local"));
		await drain();
		expect(idsIn(LIVE)).toEqual(["a", "local"]);

		// 2. The other device's revision lands: [a, remote] (it never saw "local").
		fake.externalWrite(LIVE, bytes(["a", "remote"]));
		const adopted = await a.ink.adoptExternal(PATH, () => true);
		// Precondition: a real adoption that registered a fork.
		expect(adopted.outcome).toBe("adopted");
		const forks = listForks();
		expect(forks).toHaveLength(1);
		const rec = forks[0]!;
		expect(rec.pageId).toBe(PAGE_ID);
		expect(idsIn(rec.outgoingPath)).toEqual(expect.arrayContaining(["a", "local"]));
		expect(idsIn(rec.incomingPath)).toEqual(["a", "remote"]);

		// 3. The user keeps drawing on this device after the fork.
		a.ink.commit(PATH, stroke("postfork"));
		await drain();
		// Precondition: the post-fork stroke is saved to the live sidecar and
		// is in neither artifact.
		expect(idsIn(LIVE)).toEqual(["a", "remote", "postfork"]);
		expect(idsIn(rec.outgoingPath)).not.toContain("postfork");
		expect(idsIn(rec.incomingPath)).not.toContain("postfork");
		expect(filesHolding("postfork")).toEqual([LIVE]);

		// 4. "Fix ink de-sync": the host main.ts builds (forkHostFor), with its open-note restore.
		const host: ForkHost = forkHostFor({
			adapter: {
				read: (p) => fake.read(p),
				stat: (p) => fake.stat(p),
				list: async (folder) => ({ files: [...fake.files.keys()].filter((k) => k.startsWith(folder + "/")) }),
			},
			store: a.store,
			restoreOpen: async (pageId, data) => (await a.ink.restoreRevision(pageId, data)) !== null,
		});
		const account = await describeFork(host, rec);
		// Precondition: the modal would list this fork and offer keep-mine.
		expect(account.needsDecision).toBe(true);
		expect(account.mineOnly).toBe(1);

		const filesBefore = new Set(fake.files.keys());
		const out = await applyForkDecision(host, rec, "keep-mine");
		await drain();
		expect(out).toMatchObject({ kind: "applied", wrote: true });
		// keep-mine did put the fork-time revision back as the live page.
		expect(idsIn(LIVE)).toEqual(["a", "local"]);

		const newFiles = [...fake.files.keys()].filter((k) => !filesBefore.has(k));
		// Diagnostic context for the assertion message.
		const where = filesHolding("postfork");
		const context = `files holding postfork after keep-mine: ${JSON.stringify(where)}; new files: ${JSON.stringify(newFiles)}; log tail: ${JSON.stringify(fake.log.slice(-6))}; in-memory ids: ${JSON.stringify(a.ink.strokes(PATH).map((s) => s.id))}`;

		// CORRECT BEHAVIOUR: a stroke the user drew and saved after the fork is
		// not destroyed by choosing "Keep this device's ink" - it survives in
		// the live page or in some preserved copy on disk.
		expect(where.length, context).toBeGreaterThan(0);
	});
});
