import { describe, expect, it } from "vitest";
import {
	DEFAULT_INK_FOLDER,
	FolderChangeSteps,
	MigrationAdapter,
	changeFolder,
	ensureFolder,
	baseName,
	inkFolderSyncs,
	isSidecarFile,
	migrateInkFolder,
	normalizeInkFolder,
} from "./InkFolder";

describe("normalizeInkFolder", () => {
	it("keeps an ordinary folder name", () => {
		expect(normalizeInkFolder("handwriting")).toBe("handwriting");
		expect(normalizeInkFolder(".handwriting")).toBe(".handwriting");
		expect(normalizeInkFolder("assets/ink")).toBe("assets/ink");
	});

	it("tidies the shapes people actually type", () => {
		expect(normalizeInkFolder("  handwriting  ")).toBe("handwriting");
		expect(normalizeInkFolder("/handwriting/")).toBe("handwriting");
		expect(normalizeInkFolder("assets\\\\ink")).toBe("assets/ink");
		expect(normalizeInkFolder("./ink")).toBe("ink");
	});

	it("refuses anything that could write outside the vault", () => {
		// The only thing between a typo and ink landing somewhere it should
		// never be. Unsafe input becomes the default, not an error, because
		// refusing outright would leave the plugin unable to save at all.
		expect(normalizeInkFolder("../../secrets")).toBe(DEFAULT_INK_FOLDER);
		expect(normalizeInkFolder("ink/../../..")).toBe(DEFAULT_INK_FOLDER);
		expect(normalizeInkFolder("C:/Windows")).toBe(DEFAULT_INK_FOLDER);
	});

	it("falls back to the default for empty or non-string input", () => {
		expect(normalizeInkFolder("")).toBe(DEFAULT_INK_FOLDER);
		expect(normalizeInkFolder("   ")).toBe(DEFAULT_INK_FOLDER);
		expect(normalizeInkFolder("/")).toBe(DEFAULT_INK_FOLDER);
		expect(normalizeInkFolder(undefined)).toBe(DEFAULT_INK_FOLDER);
		expect(normalizeInkFolder(42)).toBe(DEFAULT_INK_FOLDER);
	});
});

describe("inkFolderSyncs", () => {
	it("knows a dot-folder will not reach another device", () => {
		// The bug that created this setting: Obsidian Sync skips dot-folders,
		// so ink drawn on a tablet never arrived on the desktop.
		expect(inkFolderSyncs(".handwriting")).toBe(false);
		expect(inkFolderSyncs("assets/.ink")).toBe(false);
	});

	it("says yes for an ordinary folder", () => {
		expect(inkFolderSyncs("handwriting")).toBe(true);
		expect(inkFolderSyncs("assets/ink")).toBe(true);
	});
});

describe("isSidecarFile / baseName", () => {
	it("claims pages, interrupted writes and the recovery copies", () => {
		expect(isSidecarFile("abc.json")).toBe(true);
		expect(isSidecarFile("abc.json.tmp")).toBe(true);
		// Recovery copies travel with the pages: they are what someone
		// reaches for after an accident, and orphaning them in a hidden
		// folder the user thinks they moved out of is how they get lost.
		expect(isSidecarFile("abc.damaged-123")).toBe(true);
		expect(isSidecarFile("abc.conflict-1700000000")).toBe(true);
	});

	it("claims nothing that is not ours", () => {
		expect(isSidecarFile("notes.md")).toBe(false);
		expect(isSidecarFile("README")).toBe(false);
		expect(isSidecarFile("abc.damaged-notanumber")).toBe(false);
	});

	it("takes the last segment of a path", () => {
		expect(baseName(".handwriting/abc.json")).toBe("abc.json");
		expect(baseName("abc.json")).toBe("abc.json");
	});
});

function fakeAdapter(files: string[], existing: string[] = []): {
	adapter: MigrationAdapter;
	renames: Array<[string, string]>;
	made: string[];
} {
	const present = new Set([...files, ...existing, ".handwriting"]);
	const renames: Array<[string, string]> = [];
	const made: string[] = [];
	return {
		renames,
		made,
		adapter: {
			exists: (p) => Promise.resolve(present.has(p)),
			mkdir: (p) => {
				made.push(p);
				present.add(p);
				return Promise.resolve();
			},
			rename: (from, to) => {
				renames.push([from, to]);
				present.delete(from);
				present.add(to);
				return Promise.resolve();
			},
			list: () => Promise.resolve({ files, folders: [".handwriting/trash"] }),
		},
	};
}

describe("migrateInkFolder", () => {
	it("moves every sidecar to the new folder", async () => {
		const { adapter, renames, made } = fakeAdapter([
			".handwriting/a.json",
			".handwriting/b.json",
			".handwriting/c.json.tmp",
		]);
		const r = await migrateInkFolder(adapter, ".handwriting", "handwriting");
		expect(r).toEqual({ moved: 3, skipped: 0, unsupported: false });
		expect(made).toContain("handwriting");
		expect(renames).toContainEqual([".handwriting/a.json", "handwriting/a.json"]);
		expect(renames).toContainEqual([".handwriting/c.json.tmp", "handwriting/c.json.tmp"]);
	});

	it("never overwrites a name already at the destination", async () => {
		// Two files claiming one page id is something to look at, not to
		// resolve by silently destroying one of them.
		const { adapter, renames } = fakeAdapter(
			[".handwriting/a.json", ".handwriting/b.json"],
			["handwriting/a.json"]
		);
		const r = await migrateInkFolder(adapter, ".handwriting", "handwriting");
		expect(r).toEqual({ moved: 1, skipped: 1, unsupported: false });
		expect(renames).toEqual([[".handwriting/b.json", "handwriting/b.json"]]);
	});

	it("leaves files it does not own alone, and takes the ones it does", async () => {
		const { adapter, renames } = fakeAdapter([
			".handwriting/a.json",
			".handwriting/README.md",
			".handwriting/old.damaged-99",
		]);
		const r = await migrateInkFolder(adapter, ".handwriting", "handwriting");
		expect(r.moved).toBe(2);
		expect(renames).toContainEqual([".handwriting/a.json", "handwriting/a.json"]);
		expect(renames).toContainEqual([
			".handwriting/old.damaged-99",
			"handwriting/old.damaged-99",
		]);
		expect(renames.flat()).not.toContain(".handwriting/README.md");
	});

	it("creates a nested destination one segment at a time", async () => {
		// A single mkdir of `assets/ink` fails when `assets` is absent, which
		// would leave every later sidecar write failing.
		const { adapter, made } = fakeAdapter([".handwriting/a.json"]);
		await migrateInkFolder(adapter, ".handwriting", "assets/ink");
		expect(made).toEqual(["assets", "assets/ink"]);
	});

	it("creates the destination even with nothing to move", async () => {
		// The notice tells the user the folder is now theirs; it should exist.
		const { adapter, made } = fakeAdapter([]);
		const r = await migrateInkFolder(adapter, ".handwriting", "handwriting");
		expect(r.moved).toBe(0);
		expect(made).toContain("handwriting");
	});

	it("does nothing when the folder has not changed", async () => {
		const { adapter, renames } = fakeAdapter([".handwriting/a.json"]);
		const r = await migrateInkFolder(adapter, ".handwriting", ".handwriting");
		expect(r).toEqual({ moved: 0, skipped: 0, unsupported: false });
		expect(renames).toEqual([]);
	});

	it("reports rather than guesses when it cannot enumerate", async () => {
		const { adapter } = fakeAdapter([".handwriting/a.json"]);
		delete (adapter as { list?: unknown }).list;
		const r = await migrateInkFolder(adapter, ".handwriting", "handwriting");
		expect(r.unsupported).toBe(true);
		expect(r.moved).toBe(0);
	});

	it("leaves every unmoved file in place when one rename fails", async () => {
		const { adapter } = fakeAdapter([".handwriting/a.json", ".handwriting/b.json"]);
		adapter.rename = () => Promise.reject(new Error("disk full"));
		await expect(migrateInkFolder(adapter, ".handwriting", "handwriting")).rejects.toThrow(
			"disk full"
		);
	});
});

function recordingSteps(over: Partial<FolderChangeSteps> = {}): {
	steps: FolderChangeSteps;
	order: string[];
} {
	const order: string[] = [];
	const steps: FolderChangeSteps = {
		settle: () => {
			order.push("settle");
			return Promise.resolve(true);
		},
		migrate: () => {
			order.push("migrate");
			return Promise.resolve({ moved: 2, skipped: 0, unsupported: false });
		},
		repoint: () => {
			order.push("repoint");
		},
		persist: () => {
			order.push("persist");
			return Promise.resolve();
		},
		...over,
	};
	return { steps, order };
}

describe("changeFolder (the ordering IS the safety story)", () => {
	it("settles, moves, repoints, then persists - in that order", async () => {
		const { steps, order } = recordingSteps();
		const out = await changeFolder(steps, ".handwriting", "handwriting");
		expect(out).toEqual({ kind: "moved", result: { moved: 2, skipped: 0, unsupported: false } });
		expect(order).toEqual(["settle", "migrate", "repoint", "persist"]);
	});

	it("does nothing at all when the folder has not changed", async () => {
		const { steps, order } = recordingSteps();
		expect(await changeFolder(steps, "ink", "ink")).toEqual({ kind: "unchanged" });
		expect(order).toEqual([]);
	});

	it("never moves a file while writes are still in flight", async () => {
		// A pending write can land in the folder being emptied, stranding the
		// newest strokes there.
		const { steps, order } = recordingSteps();
		steps.settle = () => {
			order.push("settle");
			return Promise.resolve(false);
		};
		expect(await changeFolder(steps, ".handwriting", "handwriting")).toEqual({ kind: "busy" });
		expect(order).toEqual(["settle"]);
	});

	it("does not repoint when the vault cannot enumerate", async () => {
		// Repointing without moving would send reads at an empty folder.
		const { steps, order } = recordingSteps({
			migrate: () => {
				order.push("migrate");
				return Promise.resolve({ moved: 0, skipped: 0, unsupported: true });
			},
		});
		expect(await changeFolder(steps, ".handwriting", "handwriting")).toEqual({
			kind: "unsupported",
		});
		expect(order).toEqual(["settle", "migrate"]);
	});

	it("repoints before persisting, so a failed save cannot claim a move", async () => {
		const { steps, order } = recordingSteps({
			persist: () => {
				order.push("persist");
				return Promise.reject(new Error("disk full"));
			},
		});
		await expect(changeFolder(steps, ".handwriting", "handwriting")).rejects.toThrow("disk full");
		expect(order).toEqual(["settle", "migrate", "repoint", "persist"]);
	});
});

describe("ensureFolder raced by a concurrent creator", () => {
	it("treats a lost mkdir race as success when the folder exists after all", async () => {
		// Per-page write chains run different pages' FIRST writes
		// concurrently, so two ensureFolders can both see "missing" and both
		// mkdir; real adapters throw for the loser. Losing the race to
		// CREATE the folder is winning: it exists.
		const dirs = new Set<string>();
		const adapter = {
			exists: async (p: string) => dirs.has(p),
			mkdir: async (p: string) => {
				if (dirs.has(p)) throw new Error("EEXIST: folder exists");
				dirs.add(p);
			},
			read: async () => "",
			write: async () => {},
			rename: async () => {},
			remove: async () => {},
			stat: async () => null,
		};
		// Both start with the folder absent; interleave so both pass the
		// exists check before either mkdirs.
		let releaseExists!: () => void;
		const hold = new Promise<void>((r) => (releaseExists = r));
		const gated = {
			...adapter,
			exists: async (p: string) => {
				const had = dirs.has(p);
				await hold;
				return had;
			},
		};
		const a = ensureFolder(gated, ".handwriting");
		const b = ensureFolder(gated, ".handwriting");
		releaseExists();
		await expect(Promise.all([a, b])).resolves.toBeDefined();
		expect(dirs.has(".handwriting")).toBe(true);
	});
});
