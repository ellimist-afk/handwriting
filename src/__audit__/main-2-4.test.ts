/**
 * Audit probe main-2-4 (1.4.21, tag 1a05f62c). Asserts the CORRECT behavior:
 * after an ambiguous startup duplicate (two notes, same handwriting-page-id,
 * no owner memory) is resolved by EDITING the copy's id value (not deleting
 * the line), the original is the only carrier of the id, so its duplicate
 * lock must lift and its new ink must be written. Red here means the lock
 * survives and the original's strokes are never scheduled for a write.
 *
 * Drives the REAL HandwritingPlugin.prototype methods (buildPageIdIndex,
 * checkPageIdentity - exactly what the "resolved" and "changed" listeners
 * call), the REAL PageIdIndex and the REAL inlineInk singleton that main.ts
 * imports. Only the vault / metadata cache and the store host are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import HandwritingPlugin from "../main";
import { PageIdIndex } from "../model/PageIdIndex";
import { inlineInk } from "../inline/InkOverlay";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const ORIG = "Original.md";
const COPY = "Original 1.md";
const SHARED = "shared-page-id";

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 10, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 10 },
		createdAt: 0,
	};
}

type FakeFile = TFile & { path: string; extension: string; basename: string };
function tfile(path: string): FakeFile {
	const f = new TFile() as FakeFile;
	f.path = path;
	f.extension = "md";
	f.basename = path.replace(/\.md$/, "");
	return f;
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(() => {
	inlineInk.handleDelete(ORIG);
	inlineInk.handleDelete(COPY);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("main-2-4: ambiguous duplicate fixed by editing the copy's id value", () => {
	it("lifts the original's duplicate lock and saves its new ink", async () => {
		// ---- vault: two notes carrying the same id, no owner memory -------------
		const fm = new Map<string, string>([
			[ORIG, SHARED],
			[COPY, SHARED],
		]);
		const files = new Map<string, FakeFile>([
			[ORIG, tfile(ORIG)],
			[COPY, tfile(COPY)],
		]);
		const app = {
			vault: {
				getMarkdownFiles: () => [...files.values()],
				getFileByPath: (p: string) => files.get(p) ?? null,
			},
			metadataCache: {
				getCache: (p: string) =>
					fm.has(p) ? { frontmatter: { "handwriting-page-id": fm.get(p) } } : null,
			},
		};

		// ---- the real inline store, with a recording host -----------------------
		const saved = emptyPage(SHARED);
		saved.surface = "inline";
		saved.strokes = [stroke("saved-1")];
		const bytes = serializePage(saved);
		const writes: string[] = [];
		const said: string[] = [];
		const host = {
			readPageId: (p: string) => fm.get(p) ?? null,
			claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
			loadSidecar: async (id: string) => parsePage(bytes, id),
			scheduleSidecar: (id: string) => void writes.push(id),
			notify: (m: string) => void said.push(m),
		} as unknown as InlineInkHost;
		inlineInk.attachHost(host);
		await inlineInk.ensureLoaded(ORIG);
		await inlineInk.ensureLoaded(COPY);
		expect(inlineInk.pageIdOf(ORIG)).toBe(SHARED);

		// ---- the real plugin methods --------------------------------------------
		const plugin = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
			app,
			settings: { pageOwners: {} as Record<string, string> },
			pageIds: new PageIdIndex(),
			ambiguousIds: new Map<string, string[]>(),
			declaimTimers: new Map<string, number>(),
			declaimedPaths: new Set<string>(),
			resolvingDuplicates: new Set<string>(),
			settingsTimer: null,
			settingsDirty: false,
			pageIdWatchReady: true,
			flushSettings: async () => {},
		}) as unknown as {
			buildPageIdIndex(): void;
			checkPageIdentity(path: string): void;
			ambiguousIds: Map<string, string[]>;
			pageIds: PageIdIndex;
		};

		// Startup census ("resolved"): the ambiguous branch, both notes locked.
		plugin.buildPageIdIndex();

		// PRECONDITIONS: the trigger state the claim describes.
		expect(plugin.ambiguousIds.get(SHARED)).toEqual([ORIG, COPY]);
		expect(inlineInk.isDuplicateLocked(ORIG)).toBe(true);
		expect(inlineInk.isDuplicateLocked(COPY)).toBe(true);
		expect(said.some((m) => m.includes("carry the same handwriting-page-id"))).toBe(true);
		// ...and the lock really withholds writes while the duplicate stands.
		inlineInk.commit(ORIG, stroke("while-locked"));
		await vi.advanceTimersByTimeAsync(0);
		expect(writes).toEqual([]);

		// ---- the user edits ONE character of the copy's id value ---------------
		// Each keystroke is a metadata "changed" event on the copy; every
		// intermediate value is a readable, safe id (so no declaim is armed).
		fm.set(COPY, "shared-page-i");
		plugin.checkPageIdentity(COPY);
		fm.set(COPY, "shared-page-ix");
		plugin.checkPageIdentity(COPY);
		// The user then keeps working in the original (body edits fire
		// "changed" for it too).
		plugin.checkPageIdentity(ORIG);
		// Let every grace timer that could be pending run out.
		await vi.advanceTimersByTimeAsync(10_000);

		// The duplicate IS resolved on disk: exactly one note carries SHARED.
		const carriers = [...files.keys()].filter((p) => fm.get(p) === SHARED);
		expect(carriers).toEqual([ORIG]);

		// ---- CORRECT behavior ----------------------------------------------------
		writes.length = 0;
		inlineInk.commit(ORIG, stroke("after-fix"));
		await vi.advanceTimersByTimeAsync(0);

		expect.soft(
			inlineInk.isDuplicateLocked(ORIG),
			"original stays duplicate-locked after the copy's id was changed"
		).toBe(false);
		expect.soft(
			writes,
			"a stroke on the original after the fix is never scheduled for a write"
		).toContain(SHARED);
		expect.soft(
			said.some((m) => m.includes("duplicate resolved")),
			"the 'duplicate resolved' notice never appears"
		).toBe(true);
		expect.soft(
			plugin.ambiguousIds.has(SHARED),
			"the resolved pair is still recorded as ambiguous"
		).toBe(false);
	});
});
