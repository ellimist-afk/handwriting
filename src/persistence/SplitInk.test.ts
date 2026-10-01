/**
 * The split-ink detector, including the property that matters most: it can
 * tell "I looked and found nothing" apart from "I could not look".
 *
 * The fake adapter below carries `write`, `rename`, `mkdir` and `remove`
 * members that THROW, and is handed over as the read-only interface. If a
 * later edit ever reaches for one of them, the suite fails loudly instead of
 * a detector quietly growing a repair nobody asked for.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_INK_FOLDER, SYNCED_INK_FOLDER } from "./InkFolder";
import {
	findSplitInk,
	splitInkFolders,
	splitInkReportText,
	type SplitInkAdapter,
	type SplitInkReport,
} from "./SplitInk";

/** A page sidecar's JSON, with as many objects of each kind as asked for. */
function page(pageId: string, strokes: number, textBoxes = 0, images = 0): string {
	const n = (count: number, make: (i: number) => unknown) =>
		Array.from({ length: count }, (_, i) => make(i));
	return JSON.stringify({
		schemaVersion: 3,
		pageId,
		textBoxes: n(textBoxes, (i) => ({ id: `tb${i}`, x: 0, y: 0, width: 10, z: 0 })),
		images: n(images, (i) => ({ id: `im${i}`, x: 0, y: 0, width: 10, height: 10, z: 0 })),
		strokes: n(strokes, (i) => ({ id: `s${i}`, pts: [0, 0, 1, 1] })),
	});
}

interface FakeOptions {
	/** No `list` member at all - an adapter that cannot enumerate. */
	noList?: boolean;
	/** `list` rejects for this folder (or for every folder when true). */
	listThrows?: string | true;
	/** `read` rejects for these exact paths. */
	readThrows?: string[];
}

/**
 * An in-memory vault. Files are keyed by full path; folders are implied by
 * the paths, plus anything in `emptyFolders`.
 */
function fakeVault(
	files: Record<string, string>,
	emptyFolders: string[] = [],
	opts: FakeOptions = {}
) {
	const folderOf = (p: string) => p.slice(0, p.lastIndexOf("/"));
	const folders = new Set<string>([...emptyFolders]);
	for (const p of Object.keys(files)) folders.add(folderOf(p));

	const forbidden = (verb: string) => (): never => {
		throw new Error(`SplitInk must never ${verb}: this slice is read-only`);
	};

	const adapter = {
		exists: async (p: string): Promise<boolean> =>
			Object.prototype.hasOwnProperty.call(files, p) || folders.has(p),
		read: async (p: string): Promise<string> => {
			if (opts.readThrows?.includes(p)) throw new Error(`unreadable: ${p}`);
			const text = files[p];
			if (text === undefined) throw new Error(`no such file: ${p}`);
			return text;
		},
		// Present so a stray call is a loud failure, never a silent write.
		write: forbidden("write"),
		rename: forbidden("rename"),
		mkdir: forbidden("mkdir"),
		remove: forbidden("remove"),
	} as Record<string, unknown>;

	if (!opts.noList) {
		adapter.list = async (p: string): Promise<{ files: string[]; folders: string[] }> => {
			if (opts.listThrows === true || opts.listThrows === p) {
				throw new Error(`cannot list: ${p}`);
			}
			return {
				files: Object.keys(files).filter((f) => folderOf(f) === p),
				folders: [...folders].filter((f) => f !== p && folderOf(f) === p),
			};
		};
	}
	// Handed over as the narrow read-only interface, exactly as main.ts does.
	return adapter as unknown as SplitInkAdapter;
}

describe("splitInkFolders: the configured folder plus BOTH well-known ones", () => {
	it("de-duplicates when the configured folder is already one of them", () => {
		expect(splitInkFolders(DEFAULT_INK_FOLDER)).toEqual([
			DEFAULT_INK_FOLDER,
			SYNCED_INK_FOLDER,
		]);
		expect(splitInkFolders(SYNCED_INK_FOLDER)).toEqual([
			SYNCED_INK_FOLDER,
			DEFAULT_INK_FOLDER,
		]);
	});

	it("is THREE folders for a custom setting - both known ones are fallbacks", () => {
		expect(splitInkFolders("assets/ink")).toEqual([
			"assets/ink",
			DEFAULT_INK_FOLDER,
			SYNCED_INK_FOLDER,
		]);
	});
});

describe("findSplitInk", () => {
	it("finds a page whose two copies hold different ink, and says which one shows", async () => {
		const adapter = fakeVault({
			".handwriting/abc.json": page("abc", 7, 1, 0),
			"handwriting/abc.json": page("abc", 3, 0, 2),
		});
		const report = await findSplitInk(adapter, DEFAULT_INK_FOLDER);

		expect(report.enumerable).toBe(true);
		expect(report.scanned).toBe(2);
		expect(report.split).toHaveLength(1);
		const found = report.split[0]!;
		expect(found.pageId).toBe("abc");
		// The configured folder's copy is the one PageStore.findSidecar
		// returns first, so it is the one the app shows.
		expect(found.shownPath).toBe(".handwriting/abc.json");
		expect(found.hiddenPaths).toEqual(["handwriting/abc.json"]);
		expect(found.counts[".handwriting/abc.json"]).toEqual({
			strokes: 7,
			textBoxes: 1,
			images: 0,
		});
		expect(found.counts["handwriting/abc.json"]).toEqual({
			strokes: 3,
			textBoxes: 0,
			images: 2,
		});
		expect(report.identicalOnly).toBe(0);
		expect(report.unreadable).toEqual([]);
	});

	it("a clean vault: nothing split, everything counted, and it could look", async () => {
		const adapter = fakeVault({
			".handwriting/abc.json": page("abc", 4),
			".handwriting/def.json": page("def", 9),
			".handwriting/ghi.json": page("ghi", 0),
		});
		const report = await findSplitInk(adapter, DEFAULT_INK_FOLDER);

		expect(report.split).toEqual([]);
		expect(report.scanned).toBe(3);
		expect(report.enumerable).toBe(true);
		expect(report.identicalOnly).toBe(0);
	});

	it("byte-identical copies are duplicates, not a fork: counted apart, not reported", async () => {
		const same = page("abc", 5, 2, 1);
		const adapter = fakeVault({
			".handwriting/abc.json": same,
			"handwriting/abc.json": same,
		});
		const report = await findSplitInk(adapter, DEFAULT_INK_FOLDER);

		expect(report.split).toEqual([]);
		expect(report.identicalOnly).toBe(1);
		expect(report.enumerable).toBe(true);
		expect(report.scanned).toBe(2);
	});

	it("a CUSTOM configured folder still falls back to both known ones", async () => {
		const adapter = fakeVault({
			"assets/ink/abc.json": page("abc", 2),
			".handwriting/abc.json": page("abc", 11),
		});
		const report = await findSplitInk(adapter, "assets/ink");

		expect(report.folders).toEqual(["assets/ink", DEFAULT_INK_FOLDER, SYNCED_INK_FOLDER]);
		expect(report.split).toHaveLength(1);
		expect(report.split[0]!.shownPath).toBe("assets/ink/abc.json");
		expect(report.split[0]!.hiddenPaths).toEqual([".handwriting/abc.json"]);
	});

	it("`.conflict-` and `.damaged-` copies beside a page are artefacts, not forks", async () => {
		const adapter = fakeVault({
			".handwriting/abc.json": page("abc", 4),
			".handwriting/abc.conflict-1756000000.json": page("abc", 5),
			".handwriting/abc.conflict-1756000000-2.json": page("abc", 6),
			".handwriting/abc.damaged-1756000001.json": "{ not json",
			".handwriting/abc.superseded-1756000002.json": page("abc", 3),
			".handwriting/abc.flush-conflict-1756000003.json": page("abc", 7),
			"handwriting/def.json": page("def", 1),
		});
		const report = await findSplitInk(adapter, DEFAULT_INK_FOLDER);

		expect(report.split).toEqual([]);
		expect(report.identicalOnly).toBe(0);
		// Only the two real pages are sidecars; the three artefacts are not.
		expect(report.scanned).toBe(2);
	});

	it("ignores interrupted writes (`.json.tmp`)", async () => {
		const adapter = fakeVault({
			".handwriting/abc.json": page("abc", 4),
			".handwriting/abc.json.tmp": page("abc", 5),
			"handwriting/abc.json.tmp": page("abc", 6),
		});
		const report = await findSplitInk(adapter, DEFAULT_INK_FOLDER);

		expect(report.scanned).toBe(1);
		expect(report.split).toEqual([]);
	});

	it("an unreadable copy is still reported, marked, and does not throw", async () => {
		const adapter = fakeVault({
			".handwriting/abc.json": page("abc", 4),
			"handwriting/abc.json": "{{{ this never parsed",
		});
		const report = await findSplitInk(adapter, DEFAULT_INK_FOLDER);

		expect(report.split).toHaveLength(1);
		expect(report.split[0]!.counts[".handwriting/abc.json"]).toEqual({
			strokes: 4,
			textBoxes: 0,
			images: 0,
		});
		expect(report.split[0]!.counts["handwriting/abc.json"]).toBe("unreadable");
		expect(report.unreadable).toEqual(["handwriting/abc.json"]);
	});

	it("a copy whose READ rejects is marked unreadable rather than crashing the run", async () => {
		const adapter = fakeVault(
			{
				".handwriting/abc.json": page("abc", 4),
				"handwriting/abc.json": page("abc", 8),
			},
			[],
			{ readThrows: ["handwriting/abc.json"] }
		);
		const report = await findSplitInk(adapter, DEFAULT_INK_FOLDER);

		expect(report.split).toHaveLength(1);
		expect(report.split[0]!.counts["handwriting/abc.json"]).toBe("unreadable");
	});

	it("byte-identical copies that will not PARSE are still reported, not waved through", async () => {
		const broken = "{ half a file";
		const adapter = fakeVault({
			".handwriting/abc.json": broken,
			"handwriting/abc.json": broken,
		});
		const report = await findSplitInk(adapter, DEFAULT_INK_FOLDER);

		expect(report.identicalOnly).toBe(0);
		expect(report.split).toHaveLength(1);
		expect(report.unreadable).toEqual([".handwriting/abc.json", "handwriting/abc.json"]);
	});

	describe("could not look", () => {
		it("no list() at all: enumerable false, split EMPTY, and not a clean answer", async () => {
			const adapter = fakeVault(
				{
					".handwriting/abc.json": page("abc", 4),
					"handwriting/abc.json": page("abc", 9),
				},
				[],
				{ noList: true }
			);
			const report = await findSplitInk(adapter, DEFAULT_INK_FOLDER);

			expect(report.enumerable).toBe(false);
			expect(report.split).toEqual([]);
			// The forked page above is REAL and went unseen. Nothing in the
			// report may be read as evidence that it isn't there.
			expect(report.scanned).toBe(0);
			expect(report.identicalOnly).toBe(0);
			expect(report.unreadable).toEqual([]);
		});

		it("list() throwing on one folder: the whole report is untrustworthy, not partial", async () => {
			const adapter = fakeVault(
				{
					".handwriting/abc.json": page("abc", 4),
					"handwriting/abc.json": page("abc", 9),
				},
				[],
				{ listThrows: "handwriting" }
			);
			const report = await findSplitInk(adapter, DEFAULT_INK_FOLDER);

			expect(report.enumerable).toBe(false);
			expect(report.split).toEqual([]);
			expect(report.scanned).toBe(0);
		});

		it("a folder that simply is not there is NOT a failure to look", async () => {
			// Only `.handwriting` exists. `handwriting/` never being created
			// is the normal state of most vaults and must stay enumerable,
			// or every clean vault would report "could not look".
			const adapter = fakeVault({ ".handwriting/abc.json": page("abc", 4) });
			const report = await findSplitInk(adapter, DEFAULT_INK_FOLDER);

			expect(report.enumerable).toBe(true);
			expect(report.scanned).toBe(1);
			expect(report.split).toEqual([]);
		});

		it("the clean report and the unlistable report are DIFFERENT - the whole safety property", async () => {
			const files = { ".handwriting/abc.json": page("abc", 4) };
			const clean = await findSplitInk(fakeVault(files), DEFAULT_INK_FOLDER);
			const blind = await findSplitInk(
				fakeVault(files, [], { noList: true }),
				DEFAULT_INK_FOLDER
			);

			expect(clean.split).toEqual(blind.split); // both empty, and that is the trap
			expect(clean).not.toEqual(blind);
			expect(clean.enumerable).toBe(true);
			expect(blind.enumerable).toBe(false);
		});
	});

	it("never writes: the adapter's write verbs throw, and the run is clean anyway", async () => {
		const adapter = fakeVault({
			".handwriting/abc.json": page("abc", 4),
			"handwriting/abc.json": page("abc", 9),
			"handwriting/def.json": page("def", 1),
		});
		await expect(findSplitInk(adapter, DEFAULT_INK_FOLDER)).resolves.toMatchObject({
			enumerable: true,
		});
		// And they really would have thrown, so the assertion above means
		// something rather than passing over absent members.
		const raw = adapter as unknown as Record<string, () => void>;
		expect(() => raw.write!()).toThrow(/read-only/);
		expect(() => raw.rename!()).toThrow(/read-only/);
		expect(() => raw.mkdir!()).toThrow(/read-only/);
		expect(() => raw.remove!()).toThrow(/read-only/);
	});

	it("three folders at once: the shown copy follows findSidecar's order", async () => {
		// The configured folder has NO copy, so the app reads `.handwriting`
		// first and `handwriting` only after it - and so does this.
		const adapter = fakeVault({
			".handwriting/abc.json": page("abc", 4),
			"handwriting/abc.json": page("abc", 9),
			"assets/ink/other.json": page("other", 1),
		});
		const report = await findSplitInk(adapter, "assets/ink");

		expect(report.split).toHaveLength(1);
		expect(report.split[0]!.shownPath).toBe(".handwriting/abc.json");
		expect(report.split[0]!.hiddenPaths).toEqual(["handwriting/abc.json"]);
	});

	it("a page forked across all three folders lists both hidden copies", async () => {
		const adapter = fakeVault({
			"assets/ink/abc.json": page("abc", 1),
			".handwriting/abc.json": page("abc", 2),
			"handwriting/abc.json": page("abc", 3),
		});
		const report = await findSplitInk(adapter, "assets/ink");

		expect(report.split[0]!.shownPath).toBe("assets/ink/abc.json");
		expect(report.split[0]!.hiddenPaths).toEqual([
			".handwriting/abc.json",
			"handwriting/abc.json",
		]);
		expect(report.scanned).toBe(3);
	});
});

describe("splitInkReportText: the three reports a user can be given", () => {
	const base: SplitInkReport = {
		folders: [DEFAULT_INK_FOLDER, SYNCED_INK_FOLDER],
		scanned: 12,
		split: [],
		identicalOnly: 0,
		unreadable: [],
		enumerable: true,
	};

	it("clean", () => {
		expect(splitInkReportText(base, new Map())).toBe(
			"No split ink files. Every note's ink is in one place.\n" +
				"\n" +
				"Scanned 12 sidecar files in: .handwriting, handwriting."
		);
	});

	it("could not look - and it does NOT read as clean", () => {
		const text = splitInkReportText({ ...base, enumerable: false }, new Map());
		expect(text).toBe(
			"This vault could not be listed, so nothing was checked. This is not a clean result."
		);
		expect(text).not.toContain("No split ink files");
	});

	it("one note, named, with counts and the closing promise", () => {
		const text = splitInkReportText(
			{
				...base,
				scanned: 2,
				split: [
					{
						pageId: "abc",
						shownPath: ".handwriting/abc.json",
						hiddenPaths: ["handwriting/abc.json"],
						counts: {
							".handwriting/abc.json": { strokes: 7, textBoxes: 1, images: 0 },
							"handwriting/abc.json": { strokes: 3, textBoxes: 0, images: 2 },
						},
						identical: false,
					},
				],
			},
			new Map([["abc", "Journal/Monday.md"]])
		);
		expect(text).toBe(
			"1 note has ink in more than one folder.\n" +
				"\n" +
				"Both copies are on disk and nothing has been deleted." +
				" The app shows one of them; the other is not visible in the app.\n" +
				"\n" +
				"Journal/Monday.md\n" +
				"    shown:  .handwriting/abc.json  7 strokes, 1 text boxes, 0 images\n" +
				"    hidden: handwriting/abc.json  3 strokes, 0 text boxes, 2 images\n" +
				"\n" +
				"Nothing was changed. This command only looks."
		);
	});

	it("a page with no note keeps its id, an unreadable copy says so, and duplicates get their line", () => {
		const text = splitInkReportText(
			{
				...base,
				identicalOnly: 4,
				split: [
					{
						pageId: "orphan",
						shownPath: ".handwriting/orphan.json",
						hiddenPaths: ["handwriting/orphan.json"],
						counts: {
							".handwriting/orphan.json": { strokes: 2, textBoxes: 0, images: 0 },
							"handwriting/orphan.json": "unreadable",
						},
						identical: false,
					},
					{
						pageId: "second",
						shownPath: ".handwriting/second.json",
						hiddenPaths: ["handwriting/second.json"],
						counts: {
							".handwriting/second.json": { strokes: 1, textBoxes: 0, images: 0 },
							"handwriting/second.json": { strokes: 9, textBoxes: 0, images: 0 },
						},
						identical: false,
					},
				],
			},
			new Map([["second", "Notes/Two.md"]])
		);
		expect(text).toContain("2 notes have ink in more than one folder.");
		expect(text).toContain("orphan (no note found)");
		expect(text).toContain("    hidden: handwriting/orphan.json  unreadable");
		expect(text).toContain(
			"4 further pages have identical copies in two folders." +
				" Those hold the same ink and are not split."
		);
		// The promise is the last thing on the page, always.
		expect(text.endsWith("Nothing was changed. This command only looks.")).toBe(true);
	});
});
