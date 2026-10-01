/**
 * A note whose frontmatter Obsidian cannot read refuses the page-id claim and
 * holds its ink in memory. Removing the broken block entirely is a repair too:
 * the note is ordinary Markdown with no block, where a claim is allowed. The
 * held ink and everything drawn after must then save, and survive a restart.
 *
 * Scaffolding copied from R5-L-paths-1.test.ts (production HandwritingPlugin
 * methods on a prototype-backed object, the real inlineInk, the real PageStore
 * over FakeAdapter, the real claimMarkdown), with the metadata cache modelled
 * as Obsidian 1.13.7 builds it: frontmatter only when the block parses, and a
 * first section of type "yaml" whenever a block exists.
 *
 * The control: while the block is still broken, an edit does not start another
 * claim or another notice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { parseMarkdownPage } from "../model/MarkdownPage";
import { parsePage } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkStroke } from "../ink/Stroke";

const NOTE = "budget.md";
const BROKEN = "---\ntitle: Re: budget\n---\nBody text\n";
const VALID = "---\ntitle: budget\n---\nBody text\n";

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

/**
 * Model of Obsidian 1.13.7's frontmatter read (app.js uD/KT): YAML between the
 * leading fences, and a YAML error means NO frontmatter at all. Modelled
 * errors: a plain scalar containing ": " (yaml: "Nested mappings are not
 * allowed in compact mappings"; YAML 1.2 section 7.3.3) and a duplicate key
 * ("Map keys must be unique").
 */
function obsidianFrontmatter(text: string): Record<string, string> | undefined {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines[0] !== "---") return undefined;
	const close = lines.indexOf("---", 1);
	if (close < 0) return undefined;
	const out: Record<string, string> = {};
	for (const line of lines.slice(1, close)) {
		if (line.trim() === "") continue;
		const i = line.indexOf(":");
		if (i <= 0) return undefined;
		const key = line.slice(0, i);
		const value = line.slice(i + 1).trim();
		if (value.includes(": ")) return undefined;
		if (key in out) return undefined;
		out[key] = value;
	}
	return out;
}

interface Rig {
	fake: FakeAdapter;
	note: { text: string };
	plugin: {
		notePageId(p: string): string | null;
		claimNotePageId(p: string, id: string): Promise<{ pageId: string }>;
		checkPageIdentity(p: string): void;
		declaimTimers: Map<string, number>;
	};
	declaims: number;
	notices: string[];
}

/**
 * Obsidian 1.13.7's cache for a note (app.js uD): the frontmatter only when the
 * leading block parses, and a section per top-level node, the first of type
 * "yaml" whenever a leading fenced block exists, readable or not.
 */
function obsidianCache(text: string): { frontmatter?: Record<string, string>; sections: Array<{ type: string }> } {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const block = lines[0] === "---" && lines.indexOf("---", 1) > 0;
	const body = block ? lines.slice(lines.indexOf("---", 1) + 1) : lines;
	const sections = [
		...(block ? [{ type: "yaml" }] : []),
		...(body.some((l) => l.trim() !== "") ? [{ type: "paragraph" }] : []),
	];
	const frontmatter = obsidianFrontmatter(text);
	return frontmatter === undefined ? { sections } : { frontmatter, sections };
}

function rig(noteText: string): Rig {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const file = { path: NOTE, extension: "md", basename: "budget" };
	const note = { text: noteText };
	const r = { fake, note, declaims: 0, notices: [] as string[] } as Rig;
	const plugin = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		pageIdWatchReady: true,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		declaimTimers: new Map<string, number>(),
		declaimedPaths: new Set<string>(),
		persistOwners: () => {},
		store,
		app: {
			vault: {
				adapter: fake,
				getFileByPath: (p: string) => (p === NOTE ? file : null),
				getAbstractFileByPath: (p: string) => (p === NOTE ? file : null),
				getMarkdownFiles: () => [file],
				process: async (_f: unknown, fn: (data: string) => string) => {
					await Promise.resolve();
					const before = note.text;
					const after = fn(before);
					note.text = after;
					if (after !== before) {
						// Obsidian re-parses, then fires metadataCache "changed".
						window.setTimeout(() => r.plugin.checkPageIdentity(NOTE), 20);
					}
					return after;
				},
			},
			metadataCache: {
				getCache: (p: string) => (p === NOTE ? obsidianCache(note.text) : null),
				getFileCache: (f: unknown) => (f === file ? obsidianCache(note.text) : null),
			},
		},
	}) as unknown as Rig["plugin"];
	r.plugin = plugin;
	const realDeclaimed = inlineInk.handleDeclaimed.bind(inlineInk);
	vi.spyOn(inlineInk, "handleDeclaimed").mockImplementation((p: string) => {
		r.declaims++;
		realDeclaimed(p);
	});
	// main.ts:2033-2038, verbatim in shape.
	const host: InlineInkHost = {
		readPageId: (path) => plugin.notePageId(path),
		claimId: (path, proposedId) => plugin.claimNotePageId(path, proposedId),
		loadSidecar: (pageId) => store.load(pageId),
		scheduleSidecar: (pageId, page) => store.schedule(pageId, page),
		scheduleSidecarNow: (pageId, page) => store.saveNow(pageId, page),
		notify: (message) => void r.notices.push(message),
	};
	inlineInk.attachHost(host);
	return r;
}

function idInNoteText(r: Rig): string | null {
	return parseMarkdownPage(r.note.text).pageId ?? null;
}

function idsOnDisk(r: Rig, id: string): string[] | null {
	const text = r.fake.files.get(`.handwriting/${id}.json`);
	if (text === undefined) return null;
	return parsePage(text, id).data.strokes.map((s) => s.id);
}

async function pastEveryTimer(): Promise<void> {
	for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2000);
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	inlineInk.handleDelete(NOTE);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function freshStoreIds(r: Rig, id: string): Promise<string[]> {
	const again = new PageStore({ vault: { adapter: r.fake } } as never);
	return (await again.load(id))?.data.strokes.map((s) => s.id) ?? [];
}

describe("a refused claim resumes when the broken frontmatter block is removed", () => {
	it("broken block removed: the held strokes and later ones save, and a fresh store reads them", async () => {
		const r = rig(BROKEN);
		await inlineInk.ensureLoaded(NOTE);
		inlineInk.commit(NOTE, stroke("s1", 10));
		inlineInk.commit(NOTE, stroke("s2", 20));
		await pastEveryTimer();
		expect(idInNoteText(r), "precondition: no id written into the broken block").toBeNull();
		expect(r.notices.filter((n) => n.includes("cannot read this note's frontmatter"))).toHaveLength(1);

		// The user deletes the whole block; Obsidian re-indexes and fires "changed".
		r.note.text = "Body text\n";
		r.plugin.checkPageIdentity(NOTE);
		await vi.advanceTimersByTimeAsync(0);
		await pastEveryTimer();
		inlineInk.commit(NOTE, stroke("s3", 30));
		await pastEveryTimer();

		const id = idInNoteText(r);
		expect(id, "the claim never resumed after the block was removed").not.toBeNull();
		expect(idsOnDisk(r, id!)).toEqual(["s1", "s2", "s3"]);
		expect(await freshStoreIds(r, id!)).toEqual(["s1", "s2", "s3"]);
		expect(inlineInk.strokes(NOTE).map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
	});

	it("control: an edit that leaves the block broken starts no claim and no second notice", async () => {
		const r = rig(BROKEN);
		const claims = vi.spyOn(r.plugin, "claimNotePageId");
		await inlineInk.ensureLoaded(NOTE);
		inlineInk.commit(NOTE, stroke("s1", 10));
		await pastEveryTimer();
		const before = claims.mock.calls.length;
		expect(before, "precondition: the first stroke tried to claim").toBeGreaterThan(0);

		r.note.text = "---\ntitle: Re: budget, edited\n---\nBody text, edited\n";
		r.plugin.checkPageIdentity(NOTE);
		await vi.advanceTimersByTimeAsync(0);
		inlineInk.commit(NOTE, stroke("s2", 20));
		await pastEveryTimer();

		expect(claims.mock.calls.length, "a still-broken block started another claim").toBe(before);
		expect(r.notices.filter((n) => n.includes("cannot read this note's frontmatter"))).toHaveLength(1);
		expect(idInNoteText(r)).toBeNull();
		expect(inlineInk.strokes(NOTE).map((s) => s.id)).toEqual(["s1", "s2"]);
	});
});
