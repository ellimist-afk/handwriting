/**
 * Audit probe R5-L-paths-1 (1.4.21, tag 1a05f62c). Read-only audit file.
 *
 * Claim: on a note whose frontmatter Obsidian cannot parse, the first stroke's
 * claim writes the page id into that broken block (claimMarkdown uses the
 * plugin's own line parser), Obsidian's metadata cache still reports no
 * frontmatter, so checkPageIdentity arms declaimLater, and 2 s later
 * declaimNow drops the live record. The next stroke re-claims, adopts only
 * what reached disk and saveNow replaces the queued batch: strokes drawn
 * inside the debounce window are lost. A reopen then shows no ink.
 *
 * Everything under test is production code: HandwritingPlugin's own
 * notePageId / claimNotePageId / checkPageIdentity / declaimLater /
 * declaimNow / recentPageIdFor (called on a prototype-backed object, the
 * pattern DeleteAllLockedNotice.test.ts uses), the real inlineInk singleton
 * main.ts drives, the real PageStore over FakeAdapter, and the real
 * claimMarkdown. The host wiring copies main.ts:2033-2038.
 *
 * The only model is the Obsidian runtime: its metadata cache. Obsidian 1.13.7
 * (app.js uD / KT) parses the leading --- block with the bundled `yaml`
 * library and, on any parse error, KT returns null and uD sets NO
 * frontmatter. `obsidianFrontmatter` below models exactly that for the two
 * YAML errors the fixtures use. Obsidian fires metadataCache "changed" after
 * a modify; main.ts:3742-3744 routes it to checkPageIdentity, so the fake
 * vault.process does the same 20 ms after a content change.
 *
 * Assertions state the CORRECT behaviour: every stroke drawn stays on disk
 * and on screen, and a reopened note shows its saved ink. The valid-YAML
 * control runs the identical timeline.
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
				getCache: (p: string) => (p === NOTE ? { frontmatter: obsidianFrontmatter(note.text) } : null),
				getFileCache: (f: unknown) => (f === file ? { frontmatter: obsidianFrontmatter(note.text) } : null),
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

/** Overlay mount load, first stroke, then continuous writing across the 2 s mark. */
async function writeAcrossTwoSeconds(r: Rig): Promise<{ id: string; diag: Record<string, unknown> }> {
	await inlineInk.ensureLoaded(NOTE);
	inlineInk.commit(NOTE, stroke("s1", 10));
	await vi.advanceTimersByTimeAsync(0);
	const id = idInNoteText(r);
	if (!id) throw new Error("setup: the claim wrote no id into the note text");
	const diag: Record<string, unknown> = {
		idInNoteText: id,
		obsidianFrontmatterAfterClaim: obsidianFrontmatter(r.note.text) ?? null,
		notePageIdAfterClaim: r.plugin.notePageId(NOTE),
		diskAfterFirstStroke: idsOnDisk(r, id),
	};
	// Strokes every 300 ms: never a 700 ms pause, so the debounce never fires.
	for (let i = 2; i <= 7; i++) {
		await vi.advanceTimersByTimeAsync(300);
		inlineInk.commit(NOTE, stroke(`s${i}`, 10 * i));
	}
	// t = 1800. Declaim grace (armed at t = 20) ends at t = 2020.
	await vi.advanceTimersByTimeAsync(400);
	diag.declaimsBeforeS8 = r.declaims;
	diag.recordPageIdBeforeS8 = inlineInk.pageIdOf(NOTE);
	diag.diskBeforeS8 = idsOnDisk(r, id);
	inlineInk.commit(NOTE, stroke("s8", 80));
	await pastEveryTimer();
	diag.diskAtEnd = idsOnDisk(r, id);
	diag.screenAtEnd = inlineInk.strokes(NOTE).map((s) => s.id);
	return { id, diag };
}

const ALL = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];

describe("R5-L-paths-1: first stroke on a note with frontmatter Obsidian cannot parse", () => {
	it("control: valid YAML, same timeline, keeps every stroke on disk and on screen", async () => {
		const r = rig(VALID);
		const { id, diag } = await writeAcrossTwoSeconds(r);
		console.log("[R5-L-paths-1 control]", JSON.stringify(diag));
		expect(r.plugin.notePageId(NOTE)).toBe(id);
		expect(idsOnDisk(r, id)).toEqual(ALL);
		expect(inlineInk.strokes(NOTE).map((s) => s.id)).toEqual(ALL);
	});

	// The audit's two broken-YAML cases
	// asked for the ink on disk under an id written into a block Obsidian
	// cannot read, which no id read can ever see. The ruled behaviour instead:
	// (1) no id is written into that block; (2) every stroke stays on screen
	// and in memory across the declaim window; (3) one plain notice; (4) once
	// Obsidian reads the frontmatter, the claim goes ahead and the held strokes
	// save at once.
	it("broken YAML: no id is written, every stroke stays on screen, one notice", async () => {
		const r = rig(BROKEN);
		await inlineInk.ensureLoaded(NOTE);
		for (let i = 1; i <= 8; i++) {
			inlineInk.commit(NOTE, stroke(`s${i}`, 10 * i));
			await vi.advanceTimersByTimeAsync(300);
		}
		await pastEveryTimer();
		expect(r.note.text, "an id was written into a block Obsidian cannot read").toBe(BROKEN);
		expect(idInNoteText(r)).toBeNull();
		expect(inlineInk.strokes(NOTE).map((s) => s.id)).toEqual(ALL);
		expect(r.notices.filter((n) => n.includes("cannot read this note's frontmatter"))).toHaveLength(1);
		expect([...r.fake.files.keys()].filter((k) => k.endsWith(".json"))).toEqual([]);
	});

	it("broken YAML fixed: the claim goes ahead and the held strokes save at once", async () => {
		const r = rig(BROKEN);
		await inlineInk.ensureLoaded(NOTE);
		inlineInk.commit(NOTE, stroke("s1", 10));
		inlineInk.commit(NOTE, stroke("s2", 20));
		await pastEveryTimer();
		expect(idInNoteText(r)).toBeNull();
		// The user fixes the frontmatter; Obsidian re-indexes and fires "changed".
		r.note.text = VALID;
		r.plugin.checkPageIdentity(NOTE);
		await vi.advanceTimersByTimeAsync(0);
		await pastEveryTimer();
		const id = idInNoteText(r);
		expect(id, "the claim did not go ahead once the frontmatter was readable").not.toBeNull();
		expect(idsOnDisk(r, id!)).toEqual(["s1", "s2"]);
		expect(inlineInk.strokes(NOTE).map((s) => s.id)).toEqual(["s1", "s2"]);
	});
});
