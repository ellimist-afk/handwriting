/**
 * Job1B_E_53: a census duplicate fixed by EDITING the copy's id value.
 * Real HandwritingPlugin.prototype buildPageIdIndex / checkPageIdentity,
 * real PageIdIndex, real inlineInk singleton. Only vault / metadata cache /
 * store host faked. Assertions state the CORRECT behaviour: red = bug.
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
const NEW_COPY_ID = "shared-page-ix";

function stroke(id: string): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2,
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

async function world() {
	const fm = new Map<string, string>([[ORIG, SHARED], [COPY, SHARED]]);
	const files = new Map<string, FakeFile>([[ORIG, tfile(ORIG)], [COPY, tfile(COPY)]]);
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.values()],
			getFileByPath: (p: string) => files.get(p) ?? null,
		},
		metadataCache: {
			getCache: (p: string) => (fm.has(p) ? { frontmatter: { "handwriting-page-id": fm.get(p) } } : null),
		},
	};
	const saved = emptyPage(SHARED);
	saved.surface = "inline";
	saved.strokes = [stroke("saved-1")];
	const bytes = serializePage(saved);
	const writes: string[] = [];
	const said: string[] = [];
	const host = {
		readPageId: (p: string) => fm.get(p) ?? null,
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: async (id: string) => (id === SHARED ? parsePage(bytes, id) : null),
		scheduleSidecar: (id: string) => void writes.push(id),
		notify: (m: string) => void said.push(m),
	} as unknown as InlineInkHost;
	inlineInk.attachHost(host);
	await inlineInk.ensureLoaded(ORIG);
	await inlineInk.ensureLoaded(COPY);
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
	};
	plugin.buildPageIdIndex();
	expect(inlineInk.isDuplicateLocked(ORIG)).toBe(true);
	expect(inlineInk.isDuplicateLocked(COPY)).toBe(true);
	// The user edits one character of the copy's id (each keystroke is a metadata "changed").
	fm.set(COPY, "shared-page-i");
	plugin.checkPageIdentity(COPY);
	fm.set(COPY, NEW_COPY_ID);
	plugin.checkPageIdentity(COPY);
	await vi.advanceTimersByTimeAsync(10_000);
	await inlineInk.ensureLoaded(ORIG);
	await inlineInk.ensureLoaded(COPY);
	writes.length = 0;
	return { plugin, writes, said };
}

describe("Job1B_E_53: census duplicate fixed by editing the copy's id value", () => {
	it("report (control): the original's lock lifts and its new ink is scheduled", async () => {
		const { plugin, writes, said } = await world();
		inlineInk.commit(ORIG, stroke("after-fix"));
		await vi.advanceTimersByTimeAsync(0);
		expect(inlineInk.isDuplicateLocked(ORIG)).toBe(false);
		expect(writes).toEqual([SHARED]);
		expect(said.some((m) => m.includes("duplicate resolved"))).toBe(true);
		expect(plugin.ambiguousIds.has(SHARED)).toBe(false);
	});

	it("residual: the copy's record follows its new id and its ink saves there", async () => {
		const { writes } = await world();
		inlineInk.commit(COPY, stroke("on-copy-after-fix"));
		await vi.advanceTimersByTimeAsync(0);
		expect.soft(inlineInk.pageIdOf(COPY), "copy's session record still names the old shared id").toBe(NEW_COPY_ID);
		expect.soft(inlineInk.isDuplicateLocked(COPY), "copy stays duplicate-locked after its own id was changed").toBe(false);
		expect.soft(writes, "a stroke on the copy is never written under its new id").toEqual([NEW_COPY_ID]);
		expect(writes).not.toContain(SHARED); // never leaks into the original's sidecar
	});
});
