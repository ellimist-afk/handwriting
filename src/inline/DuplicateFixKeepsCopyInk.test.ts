import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { parseMarkdownPage } from "../model/MarkdownPage";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkStroke } from "../ink/Stroke";

const A = "Original.md";
const B = "Original 1.md";
const SHARED = "shared-id";

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
		out[line.slice(0, i)] = line.slice(i + 1).trim();
	}
	return out;
}

function obsidianCache(text: string) {
	const lines = text.split("\n");
	const block = lines[0] === "---" && lines.indexOf("---", 1) > 0;
	const sections = [...(block ? [{ type: "yaml" }] : []), { type: "paragraph" }];
	const frontmatter = obsidianFrontmatter(text);
	return frontmatter === undefined ? { sections } : { frontmatter, sections };
}

function rig() {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const shared = emptyPage(SHARED);
	shared.surface = "inline";
	shared.strokes = [stroke("orig", 5)];
	fake.files.set(`.handwriting/${SHARED}.json`, serializePage(shared));
	const texts = new Map<string, string>([
		[A, `---\nhandwriting-page-id: ${SHARED}\n---\nBody\n`],
		[B, `---\nhandwriting-page-id: ${SHARED}\n---\nBody\n`],
	]);
	const files = new Map([A, B].map((p) => [p, { path: p, extension: "md", basename: p.slice(0, -3) }]));
	const notices: string[] = [];
	const plugin: any = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		pageIdWatchReady: true,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		declaimTimers: new Map<string, number>(),
		declaimedPaths: new Set<string>(),
		resolvingDuplicates: new Set<string>(),
		settings: { pageOwners: {}, cameras: {} },
		persistOwners: () => {},
		store,
		app: {
			vault: {
				adapter: fake,
				getFileByPath: (p: string) => files.get(p) ?? null,
				getAbstractFileByPath: (p: string) => files.get(p) ?? null,
				getMarkdownFiles: () => [...files.values()],
				process: async (f: { path: string }, fn: (data: string) => string) => {
					await Promise.resolve();
					const before = texts.get(f.path)!;
					const after = fn(before);
					texts.set(f.path, after);
					if (after !== before) window.setTimeout(() => plugin.checkPageIdentity(f.path), 20);
					return after;
				},
			},
			metadataCache: {
				getCache: (p: string) => (texts.has(p) ? obsidianCache(texts.get(p)!) : null),
				getFileCache: (f: { path: string }) => (texts.has(f.path) ? obsidianCache(texts.get(f.path)!) : null),
			},
		},
	});
	const host: InlineInkHost = {
		readPageId: (path) => plugin.notePageId(path),
		claimId: (path, proposedId) => plugin.claimNotePageId(path, proposedId),
		loadSidecar: (pageId) => store.load(pageId),
		scheduleSidecar: (pageId, page) => store.schedule(pageId, page),
		scheduleSidecarNow: (pageId, page) => store.saveNow(pageId, page),
		notify: (m) => void notices.push(m),
	};
	inlineInk.attachHost(host);
	const onDisk = (id: string): string[] | null => {
		const t = fake.files.get(`.handwriting/${id}.json`);
		return t === undefined ? null : parsePage(t, id).data.strokes.map((s) => s.id);
	};
	return { plugin, texts, notices, onDisk, store, fake };
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
	inlineInk.handleDelete(A);
	inlineInk.handleDelete(B);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function lockedPair() {
	const r = rig();
	await inlineInk.ensureLoaded(A);
	await inlineInk.ensureLoaded(B);
	r.plugin.buildPageIdIndex();
	expect(inlineInk.isDuplicateLocked(A), "precondition: ambiguous duplicate locks A").toBe(true);
	expect(inlineInk.isDuplicateLocked(B), "precondition: ambiguous duplicate locks B").toBe(true);
	expect(r.notices.join("\n")).toContain("Delete the handwriting-page-id line from the copy");
	return r;
}

describe("resolving an ambiguous duplicate the way the notice says keeps the copy's ink", () => {
	it("copy fixed by EDITING its id value: ink drawn on it afterwards is saved", async () => {
		const r = await lockedPair();
		r.texts.set(B, "---\nhandwriting-page-id: copy-own-id\n---\nBody\n");
		r.plugin.checkPageIdentity(B);
		await pastEveryTimer();
		expect(inlineInk.isDuplicateLocked(A), "precondition: the original is unlocked").toBe(false);

		inlineInk.commit(B, stroke("b-after-fix", 40));
		await pastEveryTimer();
		await r.store.flush?.();

		expect(inlineInk.isDuplicateLocked(B), "the copy stays locked forever").toBe(false);
		expect(r.onDisk("copy-own-id") ?? [], "stroke drawn on the fixed copy never reached disk").toContain(
			"b-after-fix"
		);
		expect(r.onDisk(SHARED)).not.toContain("b-after-fix");
	});

	it("copy fixed by EDITING its id value: the stroke drawn on it while locked moves to the new id", async () => {
		const r = await lockedPair();
		inlineInk.commit(B, stroke("b-while-locked", 40));
		await pastEveryTimer();
		r.texts.set(B, "---\nhandwriting-page-id: copy-own-id\n---\nBody\n");
		r.plugin.checkPageIdentity(B);
		await pastEveryTimer();
		await r.store.flush?.();

		expect(inlineInk.isDuplicateLocked(B), "the copy stays locked").toBe(false);
		expect(inlineInk.pageIdOf(B)).toBe("copy-own-id");
		expect(inlineInk.strokes(B).map((s) => s.id), "the copy shows its own ink, not the original's").toEqual([
			"b-while-locked",
		]);
		expect(r.onDisk("copy-own-id"), "ink drawn on the copy while locked never reached disk").toEqual([
			"b-while-locked",
		]);
		expect(r.onDisk(SHARED)).toEqual(["orig"]);
	});

	it("copy fixed by EDITING its id to one whose sidecar already holds ink: both sets are kept", async () => {
		const r = await lockedPair();
		const theirs = emptyPage("copy-own-id");
		theirs.surface = "inline";
		theirs.strokes = [stroke("already-there", 80)];
		r.fake.files.set(".handwriting/copy-own-id.json", serializePage(theirs));
		inlineInk.commit(B, stroke("b-while-locked", 40));
		await pastEveryTimer();
		r.texts.set(B, "---\nhandwriting-page-id: copy-own-id\n---\nBody\n");
		r.plugin.checkPageIdentity(B);
		await pastEveryTimer();
		await r.store.flush?.();

		expect(inlineInk.pageIdOf(B)).toBe("copy-own-id");
		expect(
			[...(r.onDisk("copy-own-id") ?? [])].sort(),
			"the carry wrote over the ink the new id's sidecar already held"
		).toEqual(["already-there", "b-while-locked"]);
		expect(inlineInk.strokes(B).map((s) => s.id).sort(), "the copy shows both sets").toEqual([
			"already-there",
			"b-while-locked",
		]);
		expect(r.onDisk(SHARED)).toEqual(["orig"]);
	});

	it("copy fixed by DELETING its id line: the stroke drawn on it while locked survives", async () => {
		const r = await lockedPair();
		inlineInk.commit(B, stroke("b-while-locked", 40));
		await pastEveryTimer();
		expect(inlineInk.strokes(B).map((s) => s.id)).toContain("b-while-locked");

		// Exactly what the notice tells the user to do.
		r.texts.set(B, "Body\n");
		r.plugin.checkPageIdentity(B);
		await pastEveryTimer();
		expect(inlineInk.isDuplicateLocked(A), "precondition: the original is unlocked").toBe(false);

		expect(inlineInk.strokes(B).map((s) => s.id), "ink drawn on the copy vanished").toContain(
			"b-while-locked"
		);
		inlineInk.commit(B, stroke("b-next", 60));
		await pastEveryTimer();
		const id = parseMarkdownPage(r.texts.get(B)!).pageId!;
		expect(id).toBeTruthy();
		expect(id).not.toBe(SHARED);
		expect(r.onDisk(id)).toEqual(["b-while-locked", "b-next"]);
	});
});
