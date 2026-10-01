/**
 * AUDIT PROBE main-2-2 (read-only audit of 1.4.21, tag 1a05f62c).
 *
 * Claim: the declaim grace (DECLAIM_GRACE_MS = 2000, main.ts:292) starts at
 * the first metadata "changed" that has no readable page id and is never
 * re-armed (main.ts:3843). Obsidian indexes frontmatter from the SAVED file and
 * the editor saves on a 2 s debounce (obsidian.d.ts:7055 "Debounced save in 2
 * seconds from now"), so once an invalid frontmatter block has been autosaved
 * the corrected block is indexed at the earliest ~2000 ms after the next
 * keystroke: after the grace timer. The timer then sees the stale invalid
 * cache, calls declaimNow -> inlineInk.handleDeclaimed, the session record is
 * dropped and nothing reloads it when the id is readable again.
 *
 * Production code driven: HandwritingPlugin.prototype.checkPageIdentity /
 * declaimLater / declaimNow / recentPageIdFor / persistOwners on an
 * Object.create instance (UnloadFlushColdReopen.test.ts idiom), the real
 * `inlineInk` singleton that main.ts declaims through, the real inline
 * attachHost block sliced out of main.ts (same slicing idiom), real PageStore
 * over FakeAdapter, real PageIdIndex.
 *
 * Faked: the Obsidian metadata cache (a mutable frontmatter), and
 * flushSettings (settings persistence, not under test).
 *
 * Assertions state the CORRECT behaviour: green = no bug, red = bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformSync } from "esbuild";
import mainSource from "../main.ts?raw";
import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageIdIndex } from "../model/PageIdIndex";
import { emptyPage, serializePage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";

const main = mainSource.replace(/\r\n/g, "\n");

function sliceBlock(start: string, end: string): string {
	const occurrences = main.split(start).length - 1;
	if (occurrences !== 1) throw new Error(`wiring marker found ${occurrences} times: ${start}`);
	const at = main.indexOf(start);
	const stop = main.indexOf(end, at);
	if (stop <= at) throw new Error(`wiring end marker not found after: ${start}`);
	return main.slice(at, stop + end.length);
}

const INLINE_WIRING = sliceBlock("\t\tinlineInk.attachHost({", "\n\t\t});");
const attachInlineHost = new Function(
	"inlineInk",
	"blockNotice",
	transformSync(INLINE_WIRING, { loader: "ts", target: "es2022" }).code
) as (this: unknown, ink: typeof inlineInk, blockNotice: (m: string) => void) => void;

const PAGE_ID = "p1";
const SIDE = `.handwriting/${PAGE_ID}.json`;

function stroke(id: string, x0: number): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2.2,
		points: [
			{ x: x0, y: 2, pressure: 0.5, t: 0 },
			{ x: x0 + 10, y: 6, pressure: 0.5, t: 8 },
		],
		bbox: { x: x0, y: 2, width: 10, height: 4 },
		createdAt: 0,
	};
}

async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 400; i++) await Promise.resolve();
}

let unique = 0;

interface Rig {
	path: string;
	plugin: Record<string, unknown> & { checkPageIdentity(path: string): void };
	/** What Obsidian's metadata cache reports for the note's frontmatter. */
	setFrontmatter(fm: Record<string, unknown> | undefined): void;
	pageIds: PageIdIndex;
	declaimTimers: Map<string, number>;
}

async function rig(): Promise<Rig> {
	const path = `Note-${++unique}.md`;
	const adapter = new FakeAdapter();
	const page = emptyPage(PAGE_ID);
	page.surface = "inline";
	page.strokes = [stroke("a", 1), stroke("b", 40), stroke("c", 80)];
	adapter.files.set(SIDE, serializePage(page));
	const store = new PageStore({ vault: { adapter } } as never);
	let fm: Record<string, unknown> | undefined = { "handwriting-page-id": PAGE_ID };
	const file = { path, extension: "md", name: path, basename: path.replace(/\.md$/, "") };
	const pageIds = new PageIdIndex();
	const declaimTimers = new Map<string, number>();
	const plugin = Object.create(HandwritingPlugin.prototype) as Rig["plugin"];
	Object.assign(plugin, {
		store,
		pageIds,
		ambiguousIds: new Map<string, string[]>(),
		declaimTimers,
		declaimedPaths: new Set<string>(),
		pageIdWatchReady: true,
		settings: { pageOwners: {} },
		settingsDirty: false,
		settingsTimer: null,
		flushSettings: async () => undefined,
		app: {
			vault: {
				adapter,
				getFileByPath: (p: string) => (p === path ? file : null),
				getMarkdownFiles: () => [file],
			},
			metadataCache: {
				// Obsidian: an unparseable YAML block reports NO frontmatter.
				getCache: (p: string) => (p === path ? { frontmatter: fm } : null),
				getFileCache: (f: { path: string }) => (f.path === path ? { frontmatter: fm } : null),
			},
		},
	});
	attachInlineHost.call(plugin, inlineInk, () => undefined);
	return {
		path,
		plugin,
		pageIds,
		declaimTimers,
		setFrontmatter: (next) => {
			fm = next;
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
});

afterEach(async () => {
	await drainMicrotasks();
	vi.useRealTimers();
});

describe("the wiring driven here is main.ts's own", () => {
	it("metadata 'changed' calls checkPageIdentity(file.path); grace is 5000 ms; declaimLater is not re-armed", () => {
		expect(main).toMatch(
			/metadataCache\.on\("changed", \(file\) => \{\n\t+if \(this\.pageIdWatchReady && file\.extension === "md"\) \{\n\t+this\.checkPageIdentity\(file\.path\);/
		);
		// The fix lengthens the grace past the save-and-index delay.
		expect(main).toContain("const DECLAIM_GRACE_MS = 5_000;");
		expect(main).toContain("if (this.declaimTimers.has(path)) return;");
		expect(INLINE_WIRING).toContain("readPageId: (path) => this.notePageId(path),");
	});
});

describe("main-2-2: invalid frontmatter autosaved, fixed on the next save", () => {
	it("CONTROL: an id unreadable for < 2000 ms keeps the note's ink (grace works when the fix is indexed in time)", async () => {
		const r = await rig();
		expect(await inlineInk.ensureLoaded(r.path)).toBe(true);
		expect(inlineInk.strokes(r.path).map((s) => s.id)).toEqual(["a", "b", "c"]);
		r.plugin.checkPageIdentity(r.path); // census-equivalent registration
		expect(r.pageIds.owner(PAGE_ID)).toBe(r.path);

		r.setFrontmatter(undefined); // invalid block indexed
		r.plugin.checkPageIdentity(r.path);
		expect(r.declaimTimers.has(r.path)).toBe(true);
		await vi.advanceTimersByTimeAsync(1500);
		r.setFrontmatter({ "handwriting-page-id": PAGE_ID, status: "done" });
		r.plugin.checkPageIdentity(r.path);
		await vi.advanceTimersByTimeAsync(5000);
		await drainMicrotasks();
		expect(inlineInk.strokes(r.path).map((s) => s.id)).toEqual(["a", "b", "c"]);
	});

	it("the claimed trigger: invalid block autosaved at T0, user types ': done' at T0+300, fix saved+indexed at T0+2350 -> ink must survive", async () => {
		const r = await rig();
		expect(await inlineInk.ensureLoaded(r.path)).toBe(true);
		expect(inlineInk.strokes(r.path).map((s) => s.id)).toEqual(["a", "b", "c"]);
		r.plugin.checkPageIdentity(r.path);
		expect(r.pageIds.owner(PAGE_ID)).toBe(r.path);

		// T0: the 2 s autosave wrote "status" (no colon) inside the block;
		// Obsidian indexes it and reports no frontmatter.
		r.setFrontmatter(undefined);
		r.plugin.checkPageIdentity(r.path);
		expect(r.declaimTimers.has(r.path)).toBe(true); // precondition: grace armed

		// T0+300: the user types ": done". requestSave is a 2 s debounce, so the
		// fixed text is written at T0+2300 and indexed ~50 ms later. Until then
		// the cache still holds the invalid block.
		await vi.advanceTimersByTimeAsync(2350);
		await drainMicrotasks();
		const midway = inlineInk.strokes(r.path).length;

		// T0+2350: the corrected block is indexed; "changed" fires.
		r.setFrontmatter({ "handwriting-page-id": PAGE_ID, status: "done" });
		r.plugin.checkPageIdentity(r.path);
		expect(r.pageIds.owner(PAGE_ID)).toBe(r.path); // the id is readable and re-registered

		// Plenty of time for anything that would bring the ink back.
		await vi.advanceTimersByTimeAsync(10_000);
		await drainMicrotasks();

		// Correct behaviour: the note's ink never left the session.
		expect(
			{ midway, after: inlineInk.strokes(r.path).map((s) => s.id) },
			"ink dropped by the declaim grace timer while the fixed frontmatter was still waiting on the 2 s autosave"
		).toEqual({ midway: 3, after: ["a", "b", "c"] });
	});
});
