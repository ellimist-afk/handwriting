/**
 * Job1B_E_49: an unusable frontmatter page id must not be adopted at claim.
 * Part A: the report as written (raw id unsafe) - expected green.
 * Part B: residual - an UNQUOTED id YAML types as a non-string (12345).
 * Real claimMarkdown / parseMarkdownPage / isSafePageId and real
 * HandwritingPlugin.prototype notePageId / claimNotePageId / checkPageIdentity
 * with the real inlineInk singleton; only vault, metadata cache and sidecar
 * disk are faked. Assertions state the CORRECT behaviour: red = bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import HandwritingPlugin from "../main";
import { claimMarkdown } from "../inline/InlineClaim";
import { parseMarkdownPage } from "../model/MarkdownPage";
import { isSafePageId } from "../model/PageData";
import { PageIdIndex } from "../model/PageIdIndex";
import { inlineInk } from "../inline/InkOverlay";
import type { InlineInkHost } from "../inline/InlineInkStore";
import type { InkStroke } from "../ink/Stroke";
import type { PageData } from "../model/PageData";

const NOTE = "Note.md";

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

describe("Job1B_E_49 part A: unsafe raw ids are replaced at claim (report as written)", () => {
	for (const bad of ["{{handwriting-id}}", "my page", "a".repeat(129), "../x"]) {
		it(`replaces ${JSON.stringify(bad.length > 20 ? bad.slice(0, 12) + "..." : bad)}`, () => {
			const md = `---\nhandwriting-page-id: ${bad}\ntags: x\n---\nBody\n`;
			expect(isSafePageId(bad)).toBe(false);
			const r = claimMarkdown(md, "fresh-id");
			expect(r.pageId).toBe("fresh-id");
			expect(r.changed).toBe(true);
			expect(parseMarkdownPage(r.content).pageId).toBe("fresh-id");
			expect(r.content).toBe("---\nhandwriting-page-id: fresh-id\ntags: x\n---\nBody\n");
		});
	}
	it("control: a safe id still wins, byte-untouched", () => {
		const md = "---\nhandwriting-page-id: theirs-1\n---\nBody\n";
		expect(claimMarkdown(md, "fresh-id")).toEqual({ content: md, pageId: "theirs-1", changed: false });
	});
});

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
	inlineInk.handleDelete(NOTE);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Job1B_E_49 part B: an id YAML types as a non-string (unquoted 12345)", () => {
	it("the id the ink is saved under is the id every read sees, and the ink survives a body edit", async () => {
		let content = "---\nhandwriting-page-id: 12345\n---\nBody\n";
		// What Obsidian's YAML parse puts in the cache: the NUMBER 12345.
		const cacheValue = (): unknown => {
			const raw = parseMarkdownPage(content).pageId;
			return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : raw;
		};
		const file = tfile(NOTE);
		const app = {
			vault: {
				getMarkdownFiles: () => [file],
				getFileByPath: (p: string) => (p === NOTE ? file : null),
				process: async (_f: unknown, fn: (d: string) => string) => {
					content = fn(content);
					return content;
				},
			},
			metadataCache: {
				getFileCache: () => ({ frontmatter: { "handwriting-page-id": cacheValue() } }),
				getCache: () => ({ frontmatter: { "handwriting-page-id": cacheValue() } }),
			},
		};
		const plugin = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
			app,
			settings: { pageOwners: {} as Record<string, string> },
			pageIds: new PageIdIndex(),
			ambiguousIds: new Map<string, string[]>(),
			declaimTimers: new Map<string, number>(),
			declaimedPaths: new Set<string>(),
			resolvingDuplicates: new Set<string>(),
			badPageIds: new Set<string>(),
			settingsTimer: null,
			settingsDirty: false,
			settingsReadFailed: false,
			pageIdWatchReady: true,
			flushSettings: async () => {},
		}) as unknown as {
			notePageId(p: string): string | null;
			claimNotePageId(p: string, id: string): Promise<{ pageId: string }>;
			checkPageIdentity(p: string): void;
		};

		const disk = new Map<string, PageData>();
		const host = {
			readPageId: (p: string) => plugin.notePageId(p),
			claimId: (p: string, id: string) => plugin.claimNotePageId(p, id),
			loadSidecar: async (id: string) => {
				const d = disk.get(id);
				return d ? { data: structuredClone(d), recovered: false } : null;
			},
			scheduleSidecar: (id: string, page: PageData) => void disk.set(id, structuredClone(page)),
			scheduleSidecarNow: async (id: string, page: PageData) => void disk.set(id, structuredClone(page)),
			notify: () => {},
		} as unknown as InlineInkHost;
		inlineInk.attachHost(host);

		expect(plugin.notePageId(NOTE)).toBeNull();
		await inlineInk.ensureLoaded(NOTE);
		inlineInk.commit(NOTE, stroke("s1"));
		inlineInk.save(NOTE);
		await inlineInk.settle();
		const savedUnder = inlineInk.pageIdOf(NOTE);
		expect(savedUnder).not.toBeNull();
		expect(disk.has(savedUnder!)).toBe(true);

		expect.soft(plugin.notePageId(NOTE), "claim adopted an id that every later read rejects").toBe(savedUnder);

		plugin.checkPageIdentity(NOTE);
		await vi.advanceTimersByTimeAsync(10_000);
		await inlineInk.ensureLoaded(NOTE);
		expect.soft(
			inlineInk.strokes(NOTE).map((s) => s.id),
			"the just-drawn ink disappears from the note after a body edit"
		).toContain("s1");
	});
});
