/**
 * AUDIT PROBE EmbedFold-3 (read-only audit of 1.4.21, tag 1a05f62c).
 *
 * Claim: a note whose frontmatter handwriting-page-id is not a safe id (for
 * example "my page") is treated as unclaimed by notePageId, which promises
 * "Drawing on it will assign a new one". On the first stroke, claimNotePageId
 * runs claimMarkdown, which adopts ANY non-empty frontmatter id unvalidated,
 * writes nothing, and hands the unsafe id back. InlineInkStore.claim then
 * adopts it, PageStore.pathIn throws, load reports damaged, the record is
 * damage-locked and the ink is never saved.
 *
 * Production code driven: warnUnusablePageId, notePageId and claimNotePageId
 * sliced verbatim out of main.ts and executed with a fake `this` (vault,
 * metadataCache, real PageIdIndex); the real claimMarkdown, isSafePageId,
 * InlineInkStore and PageStore (over FakeAdapter), with the inline host wired
 * as main.ts:2033-2037.
 *
 * Assertions state the CORRECT behaviour: green = no bug, red = bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformSync } from "esbuild";
import mainSource from "../main.ts?raw";
import { claimMarkdown } from "../inline/InlineClaim";
import { InlineInkHost, InlineInkStore } from "../inline/InlineInkStore";
import { isSafePageId, parsePage } from "../model/PageData";
import { parseMarkdownPage } from "../model/MarkdownPage";
import { PageIdIndex } from "../model/PageIdIndex";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkStroke } from "../ink/Stroke";

// ---- slice the three production methods out of main.ts --------------------
const source = mainSource.replace(/\r\n/g, "\n");

function sliceMethod(signature: string): string {
	const start = `\t${signature}`;
	expect(source.split(start)).toHaveLength(2);
	const s = source.indexOf(start);
	const e = source.indexOf("\n\t}\n", s);
	expect(e).toBeGreaterThan(s);
	return source.slice(s, e + 3);
}

const warnSrc = sliceMethod("private warnUnusablePageId(path: string): void {\n");
const readSrc = sliceMethod("private notePageId(path: string): string | null {\n");
const claimSrc = sliceMethod("private async claimNotePageId(\n");
expect(readSrc).toContain("this.warnUnusablePageId(path);");
expect(claimSrc).toContain("const r = claimMarkdown(data, proposedId);");
expect(claimSrc).toContain("this.pageIds.register(path, out.pageId)");
// Host wiring precondition: the inline host uses exactly these two methods.
expect(source).toContain("readPageId: (path) => this.notePageId(path),");
expect(source).toContain("claimId: (path, proposedId) => this.claimNotePageId(path, proposedId),");
expect(source).toContain("loadSidecar: (pageId) => this.store.load(pageId),");

const Sliced = new Function(
	"Notice",
	"isSafePageId",
	"claimMarkdown",
	transformSync(`return class Sliced {\n${warnSrc}\n${readSrc}\n${claimSrc}\n};`, {
		loader: "ts",
		target: "es2022",
	}).code
);

// ---- fixtures ---------------------------------------------------------------
const NOTE = "n.md";
const BAD_ID = "my page";

function stroke(id: string, x = 10): InkStroke {
	return {
		id,
		color: "#000",
		width: 2,
		tool: "pen",
		points: [
			{ x, y: 10, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: x - 2, y: 8, width: 16, height: 16 },
		createdAt: 1,
	} as InkStroke;
}

interface Rig {
	ink: InlineInkStore;
	fake: FakeAdapter;
	notices: string[];
	claimCalls: string[];
	claimReturns: string[];
	loadIds: string[];
	note: { content: string };
	pageIds: PageIdIndex;
}

function rig(initial: string, cachedId: string): Rig {
	const notices: string[] = [];
	const NoticeCls = class {
		constructor(msg: string) {
			notices.push(msg);
		}
	};
	const Cls = Sliced(NoticeCls, isSafePageId, claimMarkdown);
	const note = { content: initial };
	const file = { path: NOTE };
	const pageIds = new PageIdIndex();
	const plugin: Record<string, unknown> = {
		app: {
			vault: {
				getFileByPath: (p: string) => (p === NOTE ? file : null),
				process: async (f: unknown, fn: (data: string) => string) => {
					if (f !== file) throw new Error("wrong file");
					note.content = fn(note.content);
					return note.content;
				},
			},
			// What Obsidian's YAML parse yields for `handwriting-page-id: my page`.
			metadataCache: {
				getFileCache: (f: unknown) =>
					f === file ? { frontmatter: { "handwriting-page-id": cachedId } } : null,
			},
		},
		badPageIds: new Set<string>(),
		pageIds,
		persistOwners: () => {},
	};
	const warn = Cls.prototype.warnUnusablePageId;
	const read = Cls.prototype.notePageId;
	const claimNote = Cls.prototype.claimNotePageId;
	plugin.warnUnusablePageId = (p: string) => warn.call(plugin, p);

	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const r: Rig = {
		ink: new InlineInkStore(),
		fake,
		notices,
		claimCalls: [],
		claimReturns: [],
		loadIds: [],
		note,
		pageIds,
	};
	const host: InlineInkHost = {
		readPageId: (p) => read.call(plugin, p),
		claimId: async (p, proposed) => {
			r.claimCalls.push(proposed);
			const out = await claimNote.call(plugin, p, proposed);
			r.claimReturns.push(out.pageId);
			return out;
		},
		loadSidecar: (id) => {
			r.loadIds.push(id);
			return store.load(id);
		},
		scheduleSidecar: (id, page) => store.schedule(id, page),
		scheduleSidecarNow: (id, page) => store.saveNow(id, page),
		notify: (m) => notices.push(m),
	};
	r.ink.attachHost(host);
	return r;
}

function sidecarsWith(fake: FakeAdapter, strokeId: string): string[] {
	const hits: string[] = [];
	for (const [path, text] of fake.files) {
		if (!path.startsWith(".handwriting/") || !path.endsWith(".json")) continue;
		try {
			const id = path.slice(".handwriting/".length, -".json".length);
			if (parsePage(text, id).data.strokes.some((s) => s.id === strokeId)) hits.push(path);
		} catch {
			// not a page
		}
	}
	return hits;
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
});

afterEach(() => {
	vi.useRealTimers();
});

async function pastEveryTimer(): Promise<void> {
	for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2000);
}

describe("EmbedFold-3: first stroke on a note with an unusable frontmatter page id", () => {
	it("assigns a new usable id, as promised, and saves the ink", async () => {
		const initial = `---\nhandwriting-page-id: ${BAD_ID}\n---\nHello\n`;
		// Trigger preconditions: the frontmatter id is present and unusable.
		expect(isSafePageId(BAD_ID)).toBe(false);
		expect(parseMarkdownPage(initial).pageId).toBe(BAD_ID);

		const t = rig(initial, BAD_ID);
		await t.ink.ensureLoaded(NOTE);
		// Precondition: notePageId rejected it and promised a new id.
		expect(t.notices.some((n) => n.includes("Drawing on it will assign a new one"))).toBe(true);
		expect(t.loadIds).toEqual([]); // no sidecar read at load: the note counts as unclaimed

		t.ink.commit(NOTE, stroke("s1"));
		await vi.advanceTimersByTimeAsync(0);
		await t.ink.settle();
		await pastEveryTimer();

		// Precondition: the first stroke went through the real claim.
		expect(t.claimCalls).toHaveLength(1);
		const proposed = t.claimCalls[0];
		expect(isSafePageId(proposed)).toBe(true);

		// CORRECT behaviour.
		// 1. The claim hands back a usable id (the proposed one), not the unsafe one.
		expect.soft(t.claimReturns[0], "claim returned id").toBe(proposed);
		// 2. The note's frontmatter now carries a usable id.
		const nowId = parseMarkdownPage(t.note.content).pageId;
		expect.soft(isSafePageId(nowId), `frontmatter id after claim: ${JSON.stringify(nowId)}`).toBe(true);
		// 3. The unsafe id is not registered in the owners ledger.
		expect.soft(t.pageIds.owner(BAD_ID) ?? null, "ledger owner of unsafe id").toBeNull();
		// 4. No "will not be saved" damage notice naming a file that does not exist.
		const damageNotice = t.notices.find((n) => n.includes("will not be saved"));
		expect.soft(damageNotice, "damage notice").toBeUndefined();
		// 5. The stroke reached disk in some sidecar.
		expect(sidecarsWith(t.fake, "s1"), `files on disk: ${[...t.fake.files.keys()].join(", ")}`).not.toHaveLength(0);
	});
});
