/**
 * An ink folder that is there, whose listing fails and whose `exists` answers false. PageStore.listIds asks `exists`
 * after a failed listing and skips the folder on false. Obsidian's `exists` answers false on any error and never
 * rejects (see lookPastExists in PageStoreLoad.ts), so a listing and a look that fail together skip a folder that is
 * there, and the partial list is answered as a whole one: the harm InkFolderListingFailed is there to stop. The desktop
 * folder that will not list while `exists` answers true is pinned in PageStore.test.ts.
 *
 * Want: the folder's stat is asked. Null, not found (ENOENT) or no code is absent: skipped. A folder it meets is
 * listed once more, and the listing fails (InkFolderListingFailed) if that fails. Any other error asks the parent
 * folder's listing: the folder's name in it is there (listed once more, as above), not in it is skipped, and a parent
 * listing that fails fails the listing. Written red-first at 64021dfb (test only). Controls: a folder that is not
 * there, and one whose stat answers not found, are skipped, as today.
 */
import { expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { InkFolderListingFailed } from "./InkFolder";
import { emptyPage, serializePage } from "../model/PageData";

type Listing = { files: string[]; folders: string[] };

const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

/**
 * Ink in both well-known folders; a listing in the host's form, as both hosts' adapters answer it: the vault's top
 * folder is asked as "", and the names come back as vault paths (bare at the top, `a/x` under `a`), files in `files`
 * and folders in `folders`, a folder from `dirs` or from a file inside it. A folder that is not there rejects, as the
 * desktop adapter's does. The top folder asked as "/" rejects too: a choice that pins the "" form (the phone reads
 * that path as the base plus "//").
 */
function rig(opts: { second: boolean; folder?: string }) {
	const fake = new FakeAdapter() as FakeAdapter & { list(folder: string): Promise<Listing> };
	fake.list = async (folder) => {
		if (folder === "/") throw coded("ENOENT list /: the top folder is asked as \"\"", "ENOENT");
		const prefix = folder === "" ? "" : `${folder}/`;
		const files = new Set<string>();
		const folders = new Set<string>();
		const meet = (p: string, isFile: boolean) => {
			if (!p.startsWith(prefix) || p.length === prefix.length) return;
			const cut = p.indexOf("/", prefix.length);
			if (cut === -1) (isFile ? files : folders).add(p);
			else folders.add(p.slice(0, cut));
		};
		for (const p of fake.files.keys()) meet(p, true);
		for (const d of fake.dirs) meet(d, false);
		if (folder !== "" && files.size === 0 && folders.size === 0 && !fake.dirs.has(folder)) throw coded(`ENOENT list ${folder}`, "ENOENT");
		return { files: [...files], folders: [...folders] };
	};
	fake.files.set(".handwriting/pdf-aa.json", serializePage(emptyPage("pdf-aa")));
	fake.dirs.add(".handwriting");
	if (opts.second) {
		fake.files.set("handwriting/pdf-aa-2.json", serializePage(emptyPage("pdf-aa-2")));
		fake.dirs.add("handwriting");
	}
	const store = new PageStore({ vault: { adapter: fake } } as never, opts.folder);
	return { fake, store };
}

/** Every listing asked, in order, from here on. */
function listsAsked(fake: ReturnType<typeof rig>["fake"]) {
	const asked: string[] = [];
	const list = fake.list.bind(fake);
	fake.list = async (folder: string) => (asked.push(folder), list(folder));
	return asked;
}

/**
 * `folder`'s listing fails (its first `listFailures` listings, all by default, with `listError`); `exists` answers
 * false for it, as Obsidian's does on an error; its stat as `stat`.
 */
function lookFails(
	fake: ReturnType<typeof rig>["fake"],
	stat: () => Promise<{ mtime: number } | null>,
	listFailures = Infinity,
	folder = "handwriting",
	listError: () => Error = () => coded(`EIO injected list ${folder}`, "EIO")
) {
	const list = fake.list.bind(fake);
	let failed = 0;
	fake.list = async (f: string) => {
		if (f === folder && failed < listFailures) {
			failed++;
			throw listError();
		}
		return list(f);
	};
	const exists = fake.exists.bind(fake);
	fake.exists = async (p: string) => (p === folder ? false : exists(p));
	const st = fake.stat.bind(fake);
	fake.stat = (async (p: string) => (p === folder ? stat() : st(p))) as typeof fake.stat;
}

async function answer(store: PageStore): Promise<unknown> {
	try {
		return await store.listIds("pdf-aa");
	} catch (e) {
		return e;
	}
}

it("a folder that is there, its listing failing and exists answering false, its stat failing (EIO): the listing fails, never a partial list", async () => {
	const { fake, store } = rig({ second: true });
	lookFails(fake, async () => {
		throw coded("EIO injected stat handwriting", "EIO");
	});
	expect(fake.files.has("handwriting/pdf-aa-2.json"), "precondition: the folder is there, holding an ink file").toBe(true);
	expect(await fake.exists("handwriting"), "precondition: exists answers false").toBe(false);
	expect(await answer(store), "a folder that is there and would not list was skipped: a partial list answered whole").toBeInstanceOf(InkFolderListingFailed);
});

it("control: a folder that is not there (its listing, exists and stat each say so) is skipped", async () => {
	const { fake, store } = rig({ second: false });
	expect(await fake.exists("handwriting"), "precondition: the folder is not there").toBe(false);
	expect(await answer(store)).toEqual(["pdf-aa"]);
});

it("control: the listing failing and exists answering false, its stat answering not found (ENOENT): skipped", async () => {
	const { fake, store } = rig({ second: false });
	lookFails(fake, async () => {
		throw coded("ENOENT injected stat handwriting", "ENOENT");
	});
	expect(await answer(store)).toEqual(["pdf-aa"]);
});

// Absence asked as the load's second look at a file asks it (lookPastExists): a null stat, ENOENT, or no code is not
// there; the folder met, or any other error, may be there.

it("absent: the listing failing and exists answering false, its stat answering null: skipped", async () => {
	const { fake, store } = rig({ second: false });
	lookFails(fake, async () => null);
	expect(await answer(store)).toEqual(["pdf-aa"]);
});

it("absent: the listing failing and exists answering false, its stat rejecting with no code (the mobile host's shape): skipped", async () => {
	const { fake, store } = rig({ second: false });
	lookFails(fake, async () => {
		throw new Error("injected: folder does not exist");
	});
	expect(await answer(store)).toEqual(["pdf-aa"]);
});

it("present: the listing failing and exists answering false, its stat meeting the folder: the listing fails, never a partial list", async () => {
	const { fake, store } = rig({ second: true });
	lookFails(fake, async () => ({ mtime: 1 }));
	expect(await answer(store), "a folder its stat met was skipped: a partial list answered whole").toBeInstanceOf(InkFolderListingFailed);
});

it("present: the first listing failing, exists answering false, its stat failing (EIO), the second listing working: every id", async () => {
	const { fake, store } = rig({ second: true });
	lookFails(fake, async () => {
		throw coded("EIO injected stat handwriting", "EIO");
	}, 1);
	expect(await answer(store), "a folder that is there was skipped instead of listed again").toEqual(["pdf-aa", "pdf-aa-2"]);
});

it("count: every listing working, no folder's exists or stat is asked", async () => {
	const { fake, store } = rig({ second: true });
	const asked: string[] = [];
	const exists = fake.exists.bind(fake);
	fake.exists = async (p: string) => (asked.push(`exists ${p}`), exists(p));
	const st = fake.stat.bind(fake);
	fake.stat = (async (p: string) => (asked.push(`stat ${p}`), st(p))) as typeof fake.stat;
	expect(await answer(store)).toEqual(["pdf-aa", "pdf-aa-2"]);
	expect(asked, "a look was added where every listing works").toEqual([]);
});

// The mobile no-code shape whose message does not say "does not exist" (the host then sets no ENOENT), a folder its
// stat meets whose second listing works, and the one look on the failed road.

it("fake: the test adapter's stat answers a folder as both hosts' adapters do, and null only for a path that is not there", async () => {
	const { fake } = rig({ second: false });
	fake.dirs.add("empty");
	expect(await fake.stat("empty"), "a folder in dirs, holding nothing").toMatchObject({ type: "folder" });
	fake.files.set("deep/inside/pdf-bb.json", "{}");
	expect(await fake.stat("deep"), "a folder holding a file two levels down, never made with mkdir").toMatchObject({ type: "folder" });
	expect(await fake.stat("deep/inside"), "a folder holding a file").toMatchObject({ type: "folder" });
	expect(await fake.stat("dee"), "a name that only starts a folder's name").toBeNull();
	expect(await fake.stat("handwriting"), "a folder that is not there").toBeNull();
	expect(await fake.stat(".handwriting/pdf-aa.json"), "a file keeps its answer").not.toHaveProperty("type");
});

it("absent: the listing failing and exists answering false, its stat rejecting with no code and no \"does not exist\" (the suite's mobile shape): skipped", async () => {
	const { fake, store } = rig({ second: false });
	lookFails(fake, async () => {
		throw new Error("could not open folder handwriting");
	});
	expect(await answer(store)).toEqual(["pdf-aa"]);
});

it("present: the first listing failing, exists answering false, its stat meeting the folder, the second listing working: every id", async () => {
	const { fake, store } = rig({ second: true });
	lookFails(fake, async () => ({ type: "folder", mtime: 0, size: 0 }) as { mtime: number }, 1);
	expect(await answer(store), "a folder its stat met was skipped instead of listed again").toEqual(["pdf-aa", "pdf-aa-2"]);
});

it("count: a failed listing asks the folder's stat once and never its exists", async () => {
	const { fake, store } = rig({ second: true });
	lookFails(fake, async () => {
		throw coded("EIO injected stat handwriting", "EIO");
	}, 1);
	const asked: string[] = [];
	const exists = fake.exists.bind(fake);
	fake.exists = async (p: string) => (asked.push(`exists ${p}`), exists(p));
	const st = fake.stat.bind(fake);
	fake.stat = (async (p: string) => (asked.push(`stat ${p}`), st(p))) as typeof fake.stat;
	expect(await answer(store)).toEqual(["pdf-aa", "pdf-aa-2"]);
	expect(asked, "the failed listing's look").toEqual(["stat handwriting"]);
});

// A look that fails with another code (not ENOENT, and a code): the phone's native layer may answer a missing folder
// that way, so it cannot say "there". The parent folder's listing settles it: the vault's top folder is asked as "",
// a nested folder asks its own parent, and the name is compared without case (Windows and macOS find `handwriting`
// when the disk holds `Handwriting`; the listed name carries the disk's case).

const otherCode = () => coded("could not open folder handwriting", "OS-X");

it("another code, not there: the listing and the look fail with another code, the parent lists without the folder: skipped", async () => {
	const { fake, store } = rig({ second: false });
	lookFails(fake, async () => {
		throw otherCode();
	}, Infinity, "handwriting", otherCode);
	expect((await fake.list("")).folders, "precondition: the parent's listing does not hold the folder").toEqual([".handwriting"]);
	expect(await answer(store), "a folder its parent does not list was taken as there").toEqual(["pdf-aa"]);
});

it("another code, there: the look fails (EACCES), the parent lists the folder with the disk's case: the listing fails, never a partial list", async () => {
	const { fake, store } = rig({ second: false });
	fake.files.set("Handwriting/pdf-aa-2.json", serializePage(emptyPage("pdf-aa-2")));
	fake.dirs.add("Handwriting");
	lookFails(fake, async () => {
		throw coded("EACCES injected stat handwriting", "EACCES");
	});
	expect((await fake.list("")).folders, "precondition: the parent lists the folder in the disk's case").toEqual([".handwriting", "Handwriting"]);
	expect(await answer(store), "a folder its parent lists in another case was skipped: a partial list answered whole").toBeInstanceOf(InkFolderListingFailed);
});

it("another code, the parent's listing failing too: the listing fails, never a partial list", async () => {
	const { fake, store } = rig({ second: true });
	lookFails(fake, async () => {
		throw coded("EACCES injected stat handwriting", "EACCES");
	}, 1);
	const list = fake.list.bind(fake);
	fake.list = async (f: string) => {
		if (f === "") throw coded("EIO injected list of the top folder", "EIO");
		return list(f);
	};
	expect(await answer(store), "a folder whose parent would not list was skipped: a partial list answered whole").toBeInstanceOf(InkFolderListingFailed);
});

it("another code, a nested folder: assets/ink asks its own parent's listing and finds its full path there: the listing fails", async () => {
	const { fake, store } = rig({ second: false, folder: "assets/ink" });
	fake.files.set("assets/ink/pdf-aa-3.json", serializePage(emptyPage("pdf-aa-3")));
	fake.dirs.add("assets");
	fake.dirs.add("assets/ink");
	lookFails(fake, async () => {
		throw coded("EACCES injected stat assets/ink", "EACCES");
	}, Infinity, "assets/ink");
	const asked = listsAsked(fake);
	expect((await fake.list("assets")).folders, "precondition: the parent's listing names the folder by its full path").toEqual(["assets/ink"]);
	asked.length = 0;
	expect(await answer(store), "a nested folder its parent lists was skipped: a partial list answered whole").toBeInstanceOf(InkFolderListingFailed);
	expect(asked, "the listings asked: the folder, its own parent, the folder again").toEqual(["assets/ink", "assets", "assets/ink"]);
});

it("count: a look failing with another code asks the parent's listing once, after the folder's own", async () => {
	const { fake, store } = rig({ second: true });
	lookFails(fake, async () => {
		throw coded("EIO injected stat handwriting", "EIO");
	}, 1);
	const asked = listsAsked(fake);
	expect(await answer(store)).toEqual(["pdf-aa", "pdf-aa-2"]);
	expect(asked, "the listings asked").toEqual([".handwriting", "handwriting", "", "handwriting"]);
});

it("count: a look that meets the folder, or answers null, not found or no code, never asks the parent's listing", async () => {
	const shapes: [string, boolean, () => Promise<{ mtime: number } | null>][] = [
		["meets the folder", true, async () => ({ type: "folder", mtime: 0, size: 0 }) as { mtime: number }],
		["null", false, async () => null],
		["not found", false, async () => { throw coded("ENOENT injected stat handwriting", "ENOENT"); }],
		["no code", false, async () => { throw new Error("could not open folder handwriting"); }],
	];
	const parents: Record<string, number> = {};
	for (const [shape, second, stat] of shapes) {
		const { fake, store } = rig({ second });
		lookFails(fake, stat, 1);
		const asked = listsAsked(fake);
		await answer(store);
		parents[shape] = asked.filter((f) => f === "").length;
	}
	expect(parents, "the parent's listings asked, by look").toEqual({ "meets the folder": 0, null: 0, "not found": 0, "no code": 0 });
});
