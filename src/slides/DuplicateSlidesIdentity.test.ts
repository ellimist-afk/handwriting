/**
 * S3 STATIC DRAFT ONLY. NOT EXECUTED, TYPECHECKED OR ADMITTED.
 * Observed base 984a5a40484a504ea9163661f77120a34365bfab,
 * tree f6580aaa06641589b41afa1544c878531c6e62d8.
 * Proposed imports are relative to the destination under src/inline, not this artifact directory.
 * See CELL-CONTRACTS.json for route limitations, future commands, plants and holds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { parseMarkdownPage } from "../model/MarkdownPage";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import { slidesSidecarId } from "../slides/SlidesInkSurface";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const A = "Original.md";
const B = "Original 1.md";
const SHARED = "shared-id";

function stroke(id: string, x = 10): InkStroke {
	const width = 2;
	const points = [{ x, y: 10, pressure: 0.5, t: 0 }, { x: x + 10, y: 20, pressure: 0.5, t: 8 }];
	return {
		id,
		color: "#000",
		width,
		tool: "pen",
		points,
		bbox: computeBBox(points, width * 2),
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


type Rig = ReturnType<typeof rig>;
function seedSlides(r: Rig) {
    const id = slidesSidecarId(SHARED);
    const page = emptyPage(id);
    page.surface = "slides";
    page.coordSpace = "slide-logical";
    page.deck = { width: 960, height: 700 };
    page.slides = [{ index: 0, hash: "1a2b3c4d" }];
    page.strokes = [stroke("slide-original", 30)];
    r.fake.files.set(`.handwriting/${id}.json`, serializePage(page));
    return page;
}
async function repairThroughMetadataHandler(r: Rig) {
    // Public trigger: duplicate the Markdown deck after the original is known, then metadata "changed".
    // Unit boundary: call that callback's real checkPageIdentity, not a fake repair or clone.
    // This fixture does not run plugin.onload or emit an Obsidian event; event integration remains unproved.
    r.plugin.pageIds.register(A, SHARED);
    await inlineInk.ensureLoaded(A);
    await inlineInk.ensureLoaded(B);
    const repair = vi.spyOn(r.plugin, "resolveDuplicate");
    r.plugin.checkPageIdentity(B);
    expect(repair, "fixture: metadata handler must reach real duplicate repair").toHaveBeenCalledTimes(1);
    await repair.mock.results[0]!.value;
    await pastEveryTimer();
    const id = parseMarkdownPage(r.texts.get(B)!).pageId;
    expect(id, "fixture: copy must receive a distinct note identity").toBeTruthy();
    expect(id).not.toBe(SHARED);
    expect(parseMarkdownPage(r.texts.get(A)!).pageId).toBe(SHARED);
    return id!;
}
async function reopened(r: Rig, id: string) {
    // A fresh PageStore over the same adapter proves persisted data, not the prior instance's cache.
    const fresh = new PageStore({ vault: { adapter: r.fake } } as never);
    return fresh.load(id);
}
describe("S3 duplicate Markdown deck keeps slides ink", () => {
    it("copied slides ink survives identity repair and later edits remain independent", async () => {
        const r = rig();
        const seeded = seedSlides(r);
        const oldId = slidesSidecarId(SHARED);
        const originalBytes = r.fake.files.get(`.handwriting/${oldId}.json`)!;
        const originalNote = r.texts.get(A);
        const id = await repairThroughMetadataHandler(r);
        expect(r.onDisk(id), "control: ordinary inline ink clone succeeds").toEqual(["orig"]);
        expect(r.texts.get(A)).toBe(originalNote);
        expect(r.fake.files.get(`.handwriting/${oldId}.json`)).toBe(originalBytes);
        const newId = slidesSidecarId(id);
        const copied = await reopened(r, newId);
        expect(copied, "duplicate repair lost the copied deck's saved slides ink").not.toBeNull();
        expect(copied!.data.surface).toBe("slides");
        expect(copied!.data.coordSpace).toBe(seeded.coordSpace);
        expect(copied!.data.deck).toEqual(seeded.deck);
        expect(copied!.data.slides).toEqual(seeded.slides);
        expect(copied!.data.strokes).toEqual(seeded.strokes);
        expect(copied!.data.pageId).toBe(newId);
        const changedCopy = { ...copied!.data, strokes: [...copied!.data.strokes, stroke("copy-only", 60)] };
        await r.store.saveNow(newId, changedCopy);
        expect((await reopened(r, oldId))!.data.strokes.map(s => s.id)).toEqual(["slide-original"]);
        expect((await reopened(r, newId))!.data.strokes.map(s => s.id)).toEqual(["slide-original", "copy-only"]);
        const original = (await reopened(r, oldId))!.data;
        await r.store.saveNow(oldId, { ...original, strokes: [...original.strokes, stroke("original-only", 90)] });
        expect((await reopened(r, newId))!.data.strokes.map(s => s.id)).toEqual(["slide-original", "copy-only"]);
        expect((await reopened(r, oldId))!.data.strokes.map(s => s.id)).toEqual(["slide-original", "original-only"]);
    });
    it("control: inline-only duplicate remains repaired with no invented slides page", async () => {
        const r = rig();
        const id = await repairThroughMetadataHandler(r);
        expect(r.onDisk(id)).toEqual(["orig"]);
        expect(r.onDisk(SHARED)).toEqual(["orig"]);
        expect(await reopened(r, slidesSidecarId(id))).toBeNull();
    });
    it("control: reopening without duplication preserves slides identity and bytes", async () => {
        const r = rig();
        seedSlides(r);
        const id = slidesSidecarId(SHARED);
        const bytes = r.fake.files.get(`.handwriting/${id}.json`);
        expect((await reopened(r, id))!.data.strokes.map(s => s.id)).toEqual(["slide-original"]);
        expect(r.fake.files.get(`.handwriting/${id}.json`)).toBe(bytes);
        expect(parseMarkdownPage(r.texts.get(A)!).pageId).toBe(SHARED);
    });
});
