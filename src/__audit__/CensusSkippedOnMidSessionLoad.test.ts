/**
 * The duplicate page-id census (the copied-note check) at plugin load.
 *
 * It ran only on the metadata cache's "resolved" event. Obsidian sends that
 * after its first index and then only when a file changes, so a plugin turned
 * on or updated while Obsidian runs got no census until some markdown file
 * changed: no copy was locked, and a note and its copy both wrote the one
 * shared ink file. At load, when the layout is ready and every markdown file
 * already has a file cache, the census now runs at once. A cold start, and a
 * load while any file is still unindexed, wait for "resolved" as before.
 *
 * The cells run the REAL registration block sliced out of main.ts (the same
 * technique as src/testUtils/LiveReloadTestHarness.ts), the REAL
 * buildPageIdIndex and the REAL inlineInk singleton, with a fake app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformSync } from "esbuild";
import { TFile } from "obsidian";
import mainSource from "../main.ts?raw";
import HandwritingPlugin from "../main";
import { PageIdIndex } from "../model/PageIdIndex";
import { inlineInk } from "../inline/InkOverlay";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const ORIG = "Original.md";
const COPY = "Original 1.md";
const SHARED = "shared-page-id";

// ---- slice the census registration out of onload --------------------------
const source = mainSource.replace(/\r\n/g, "\n");
const startMarker = "\t\tconst runCensus = () => {";
const endMarker = "\n\t}\n\n\t// ---- duplicate page ids (v0.13.6)";
expect(source.split(startMarker)).toHaveLength(2);
expect(source.split(endMarker)).toHaveLength(2);
const block = source.slice(source.indexOf(startMarker), source.indexOf(endMarker));
const installCensus = new Function(
	"TFile",
	transformSync(block, { loader: "ts", target: "es2022" }).code
) as (this: object, tfile: typeof TFile) => void;

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

interface Load {
	layoutReady: boolean;
	uncached?: string[];
	owners?: Record<string, string>;
}

async function load(opts: Load) {
	const fm = new Map<string, string>([
		[ORIG, SHARED],
		[COPY, SHARED],
	]);
	const files = new Map<string, FakeFile>([
		[ORIG, tfile(ORIG)],
		[COPY, tfile(COPY)],
	]);
	const uncached = new Set(opts.uncached ?? []);
	const metaHandlers = new Map<string, ((...a: unknown[]) => void)[]>();
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.values()],
			getFileByPath: (p: string) => files.get(p) ?? null,
			on: () => ({}),
		},
		metadataCache: {
			getCache: (p: string) =>
				uncached.has(p) ? null : fm.has(p) ? { frontmatter: { "handwriting-page-id": fm.get(p) } } : null,
			getFileCache: (f: { path: string }) =>
				uncached.has(f.path) ? null : fm.has(f.path) ? { frontmatter: { "handwriting-page-id": fm.get(f.path) } } : null,
			on: (name: string, cb: (...a: unknown[]) => void) => {
				metaHandlers.set(name, [...(metaHandlers.get(name) ?? []), cb]);
				return {};
			},
		},
		workspace: {
			layoutReady: opts.layoutReady,
			onLayoutReady: (cb: () => void) => cb(),
		},
	};

	// The real inline store with a recording host, both notes open.
	const saved = emptyPage(SHARED);
	saved.surface = "inline";
	saved.strokes = [stroke("original-1")];
	const bytes = serializePage(saved);
	const writes: string[] = [];
	const host = {
		readPageId: (p: string) => fm.get(p) ?? null,
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: async (id: string) => parsePage(bytes, id),
		scheduleSidecar: (id: string) => void writes.push(id),
		notify: () => undefined,
	} as unknown as InlineInkHost;
	inlineInk.attachHost(host);
	await inlineInk.ensureLoaded(ORIG);
	await inlineInk.ensureLoaded(COPY);

	const repairs: unknown[][] = [];
	const plugin = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		app,
		settings: { pageOwners: { ...(opts.owners ?? {}) } as Record<string, string> },
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		declaimTimers: new Map<string, number>(),
		declaimedPaths: new Set<string>(),
		resolvingDuplicates: new Set<string>(),
		settingsTimer: null,
		settingsDirty: false,
		pageIdWatchReady: false,
		flushSettings: async () => {},
		resolveDuplicate: async (...a: unknown[]) => void repairs.push(a),
		registerEvent: () => undefined,
		register: () => undefined,
	}) as { pageIdWatchReady: boolean };

	// onload's census registration.
	installCensus.call(plugin, TFile);
	await vi.advanceTimersByTimeAsync(0);
	return {
		plugin,
		writes,
		repairs,
		resolved: async () => {
			for (const cb of metaHandlers.get("resolved") ?? []) cb();
			await vi.advanceTimersByTimeAsync(0);
		},
		drawOnCopy: async () => {
			writes.length = 0;
			inlineInk.commit(COPY, stroke("drawn-on-copy"));
			await vi.advanceTimersByTimeAsync(0);
		},
	};
}

describe("the copied-note check at plugin load", () => {
	it("loaded while Obsidian runs, with a copied pair and no owner memory: both notes lock and the copy writes nothing to the shared ink file", async () => {
		const l = await load({ layoutReady: true });
		// No file changes, so Obsidian sends no "resolved".
		await l.drawOnCopy();
		expect.soft(l.plugin.pageIdWatchReady, "the census never ran on a load into an already indexed vault").toBe(true);
		expect.soft(inlineInk.isDuplicateLocked(ORIG), "the original is not duplicate-locked").toBe(true);
		expect.soft(inlineInk.isDuplicateLocked(COPY), "the copy is not duplicate-locked").toBe(true);
		expect(l.writes, "a stroke on the copy is scheduled into the shared ink file the original reads").not.toContain(SHARED);
	});

	it("loaded while Obsidian runs, with owner memory: the copy is repaired against the remembered original", async () => {
		const l = await load({ layoutReady: true, owners: { [SHARED]: ORIG } });
		expect(l.repairs, "the copy was not repaired at load").toEqual([[COPY, SHARED, ORIG]]);
	});

	it("loaded while Obsidian runs with one note not yet indexed: no census until \"resolved\"", async () => {
		const l = await load({ layoutReady: true, uncached: [COPY] });
		expect(l.plugin.pageIdWatchReady, "the census ran on a half-built index").toBe(false);
		await l.resolved();
		expect(l.plugin.pageIdWatchReady).toBe(true);
	});

	it("a cold start with every note cached runs no census before \"resolved\"", async () => {
		const l = await load({ layoutReady: false });
		expect(l.plugin.pageIdWatchReady, "the census ran before the layout was ready").toBe(false);
		await l.resolved();
		expect(l.plugin.pageIdWatchReady).toBe(true);
		expect(inlineInk.isDuplicateLocked(COPY)).toBe(true);
	});
});
