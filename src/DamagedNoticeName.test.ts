/**
 * The damaged-ink notice must name the file the store actually read (audit 186): the live sidecar in the
 * configured ink folder, or the leftover <id>.json.tmp when no live file exists. The real InlineInkStore runs
 * over the real PageStore and an in-memory adapter; only the vault around them is a stand-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineInkStore, type InlineInkHost } from "./inline/InlineInkStore";
import { PageStore } from "./persistence/PageStore";
import { FakeAdapter } from "./persistence/FakeAdapter";
import type { PageData, ParseResult } from "./model/PageData";

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
});

const DAMAGED = "{ this is not json";

async function noticeFor(folder: string, files: Record<string, string>): Promise<string[]> {
	const fake = new FakeAdapter();
	for (const [path, text] of Object.entries(files)) fake.files.set(path, text);
	const pages = new PageStore({ vault: { adapter: fake } } as never, folder, () => 5_000_000);
	const shown: string[] = [];
	const host: InlineInkHost = {
		readPageId: (path) => (path === "note.md" ? "p1" : null),
		claimId: async (_path, proposedId) => ({ pageId: proposedId }),
		loadSidecar: (pageId) => pages.load(pageId) as Promise<ParseResult | null>,
		scheduleSidecar: (_pageId: string, _page: PageData) => {},
		notify: (message) => {
			shown.push(message);
		},
	};
	const store = new InlineInkStore();
	store.attachHost(host);
	await store.ensureLoaded("note.md");
	return shown;
}

describe("damaged-ink notice names the file the store read (audit 186)", () => {
	it("a damaged live file in a non-default folder names that path, not .handwriting/", async () => {
		const shown = await noticeFor("handwriting", { "handwriting/p1.json": DAMAGED });
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain("saved ink for this note (handwriting/p1.json).");
		expect(shown[0]).not.toContain(".handwriting/");
	});

	it("a damaged live file in a custom folder names that path", async () => {
		const shown = await noticeFor("Ink/store", { "Ink/store/p1.json": DAMAGED });
		expect(shown[0]).toContain("saved ink for this note (Ink/store/p1.json).");
	});

	it("a damaged <id>.json.tmp with no live file names the .tmp", async () => {
		const shown = await noticeFor(".handwriting", { ".handwriting/p1.json.tmp": DAMAGED });
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain("saved ink for this note (.handwriting/p1.json.tmp).");
	});

	it("a damaged .tmp in a non-default folder names that .tmp", async () => {
		const shown = await noticeFor("handwriting", { "handwriting/p1.json.tmp": DAMAGED });
		expect(shown[0]).toContain("saved ink for this note (handwriting/p1.json.tmp).");
	});

	it("control: a damaged live file in the default folder reads as before", async () => {
		const shown = await noticeFor(".handwriting", { ".handwriting/p1.json": DAMAGED });
		expect(shown[0]).toContain("saved ink for this note (.handwriting/p1.json). The file has not been overwritten.");
	});
});
