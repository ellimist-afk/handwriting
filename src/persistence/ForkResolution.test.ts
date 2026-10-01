/**
 * The fork-resolution surface, executed against an in-memory vault.
 *
 * Every case drives the real `describeFork` / `applyForkDecision` over real
 * `parsePage`, and asserts what is ON DISK afterwards rather than what the
 * source says. The point of the slice is that a person can decide between two
 * preserved revisions without losing either, so "nothing was destroyed" is
 * asserted after every decision, not assumed.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	ForkHost,
	ForkRecord,
	applyForkDecision,
	describeFork,
	forkFromAdoption,
	forgetFork,
	listForks,
	recordFork,
	refreshForks,
	resetForks,
	forkHostFor,
	scanForForks,
} from "./ForkResolution";
import { PageData, parsePage } from "../model/PageData";

const PAGE = "504fdb34-aed8-42a0-8df8-66f7db7a02de";
const NOTE = "Demo/two devices.md";
const MINE = ".handwriting/p.conflict-external-t-outgoing.json";
const THEIRS = ".handwriting/p.conflict-external-t-incoming.json";

/** A sidecar with the given stroke ids, in the shape the store writes. */
function page(ids: string[]): string {
	return JSON.stringify({
		schemaVersion: 1,
		pageId: PAGE,
		surface: "inline",
		textBoxes: [],
		images: [],
		strokes: ids.map((id, i) => ({
			id,
			tool: "pen",
			color: "#5f6673",
			width: 2.86,
			createdAt: 1788853814257 + i,
			pts: [10 + i, 20 + i, 0.5, 0, 11 + i, 21 + i, 0.5, 1],
		})),
	});
}

interface Vault extends ForkHost {
	files: Map<string, string>;
	saved: { pageId: string; data: PageData }[];
}

/**
 * An in-memory vault. `saveNow` records the call and writes the live sidecar
 * beside the pair, as the store does, so a decision can read it back.
 */
function vault(seed: Record<string, string> = {}): Vault {
	const files = new Map(Object.entries(seed));
	const saved: { pageId: string; data: PageData }[] = [];
	return {
		files,
		saved,
		read: async (p: string) => files.get(p) ?? null,
		stat: async (p: string) => (files.has(p) ? { mtime: 1000 + files.get(p)!.length } : null),
		saveNow: async (pageId: string, data: PageData) => {
			saved.push({ pageId, data });
			files.set(`${MINE.slice(0, MINE.lastIndexOf("/") + 1)}${pageId}.json`, page(data.strokes.map((st) => st.id)));
		},
	};
}

function rec(at = 5): ForkRecord {
	return { pageId: PAGE, path: NOTE, outgoingPath: MINE, incomingPath: THEIRS, at };
}

beforeEach(() => resetForks());

// ---- the account -----------------------------------------------------------

describe("a fork produces an account a person could choose from", () => {
	it("reports what each side holds, and which strokes only one side has", async () => {
		const v = vault({
			[MINE]: page(["shared-1", "shared-2", "only-mine"]),
			[THEIRS]: page(["shared-1", "shared-2", "only-theirs"]),
		});

		const a = await describeFork(v, rec());

		expect(a.path).toBe(NOTE);
		expect(a.mine.readable).toBe(true);
		expect(a.theirs.readable).toBe(true);
		expect(a.mine.strokes).toBe(3);
		expect(a.theirs.strokes).toBe(3);
		expect(a.mineOnly).toBe(1);
		expect(a.theirsOnly).toBe(1);
		// Something of this device's is not in what arrived, so there is a
		// real question to put to the user.
		expect(a.needsDecision).toBe(true);
		// Last-modified is carried so the two can be told apart when the counts
		// happen to match, as they do here.
		expect(a.mine.mtime).toBeGreaterThan(0);
	});

	/**
	 * THE NEGATIVE CONTROL THE BRIEF ASKS FOR, and it is the one that keeps
	 * this surface from undoing the success-silence rule. Adoption preserves a
	 * pair EVERY time, including when the other device merely drew more. There
	 * is nothing to decide there and the user must not be asked.
	 */
	it("shows nothing when the arriving revision is a superset", async () => {
		const v = vault({
			[MINE]: page(["shared-1", "shared-2"]),
			[THEIRS]: page(["shared-1", "shared-2", "theirs-new"]),
		});

		const a = await describeFork(v, rec());

		expect(a.mineOnly).toBe(0);
		expect(a.theirsOnly).toBe(1);
		expect(a.needsDecision).toBe(false);
	});

	it("claims nothing about a side it could not read", async () => {
		const v = vault({ [THEIRS]: page(["a"]) });

		const a = await describeFork(v, rec());

		expect(a.mine.readable).toBe(false);
		expect(a.mine.strokes).toBe(0);
		// And no question is raised off a count that could not be taken.
		expect(a.needsDecision).toBe(false);
	});

	it("treats a damaged artifact as unreadable rather than as an empty page", async () => {
		const v = vault({ [MINE]: "{ this is not json", [THEIRS]: page(["a"]) });

		const a = await describeFork(v, rec());

		expect(a.mine.readable).toBe(false);
		expect(a.needsDecision).toBe(false);
	});
});

// ---- the recording boundary -------------------------------------------------

describe("only a real adoption registers a fork", () => {
	it("registers when adoption preserved both artifacts", () => {
		const f = forkFromAdoption(PAGE, NOTE, { outcome: "adopted", outgoingPath: MINE, incomingPath: THEIRS }, 7);
		expect(f).not.toBeNull();
		expect(f!.outgoingPath).toBe(MINE);
	});

	it("registers nothing for held, unavailable, or a result with no artifacts", () => {
		expect(forkFromAdoption(PAGE, NOTE, { outcome: "held" }, 7)).toBeNull();
		expect(forkFromAdoption(PAGE, NOTE, { outcome: "unavailable" }, 7)).toBeNull();
		expect(forkFromAdoption(PAGE, NOTE, { outcome: "adopted" }, 7)).toBeNull();
		expect(forkFromAdoption(null, NOTE, { outcome: "adopted", outgoingPath: MINE, incomingPath: THEIRS }, 7)).toBeNull();
	});
});

// ---- the three decisions ----------------------------------------------------

describe("each decision does the right thing on disk, and destroys nothing", () => {
	it("KEEP THIS DEVICE'S writes the preserved revision back through the ordinary save", async () => {
		const v = vault({ [MINE]: page(["a", "b", "mine"]), [THEIRS]: page(["a", "b"]) });
		recordFork(rec());

		const out = await applyForkDecision(v, rec(), "keep-mine");

		expect(out.kind).toBe("applied");
		expect(out.wrote).toBe(true);
		// Through saveNow - the same entry point every other save uses.
		expect(v.saved).toHaveLength(1);
		expect(v.saved[0]!.pageId).toBe(PAGE);
		expect(v.saved[0]!.data.strokes.map((s) => s.id)).toEqual(["a", "b", "mine"]);
		// AND THE OTHER SIDE SURVIVES.
		expect(v.files.get(THEIRS)).toBeTypeOf("string");
		expect(listForks()).toHaveLength(0);
	});

	it("TAKE THE OTHER writes nothing, and does NOT destroy this device's revision", async () => {
		const v = vault({
			[MINE]: page(["a", "mine"]),
			[THEIRS]: page(["a", "theirs"]),
			[`.handwriting/${PAGE}.json`]: page(["a", "theirs"]),
		});
		recordFork(rec());

		const out = await applyForkDecision(v, rec(), "take-theirs");

		expect(out.kind).toBe("applied");
		// The live page is already the arriving revision; writing would be a
		// change nobody asked for.
		expect(out.wrote).toBe(false);
		expect(v.saved).toHaveLength(0);
		// The whole point: this device's revision is still on disk afterwards.
		expect(v.files.get(MINE)).toBe(page(["a", "mine"]));
		expect(listForks()).toHaveLength(0);
	});

	it("TAKE THE OTHER writes the other device's revision when the live page is no longer it", async () => {
		const v = vault({
			[MINE]: page(["a", "mine"]),
			[THEIRS]: page(["a", "theirs"]),
			// Keep-mine earlier, or ink drawn since: the live page is not theirs.
			[`.handwriting/${PAGE}.json`]: page(["a", "mine"]),
		});
		recordFork(rec());

		const out = await applyForkDecision(v, rec(), "take-theirs");

		expect(out).toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(v.saved.map((s) => s.data.strokes.map((st) => st.id))).toEqual([["a", "theirs"]]);
		expect(v.files.get(MINE)).toBe(page(["a", "mine"]));
	});

	it("KEEP BOTH writes nothing and stays reachable afterwards", async () => {
		const v = vault({ [MINE]: page(["a", "mine"]), [THEIRS]: page(["a", "theirs"]) });
		recordFork(rec());

		const out = await applyForkDecision(v, rec(), "keep-both");

		expect(out.wrote).toBe(false);
		expect(v.saved).toHaveLength(0);
		expect(v.files.get(MINE)).toBeTypeOf("string");
		expect(v.files.get(THEIRS)).toBeTypeOf("string");
		// The difference from "take the other" is here and only here: the fork
		// stays listed, so the person can come back to it.
		expect(out.stillListed).toBe(true);
		expect(listForks()).toHaveLength(1);
	});
});

// ---- refusals ---------------------------------------------------------------

describe("keep-mine refuses rather than writing something else", () => {
	it("refuses when the preserved revision is gone, and keeps the fork listed", async () => {
		const v = vault({ [THEIRS]: page(["a"]) });
		recordFork(rec());

		const out = await applyForkDecision(v, rec(), "keep-mine");

		expect(out.kind).toBe("refused");
		expect(out.wrote).toBe(false);
		expect(v.saved).toHaveLength(0);
		// Still listed: the other side is still a choice the user can make.
		expect(listForks()).toHaveLength(1);
	});

	it("refuses a damaged artifact instead of writing the parser's placeholder", async () => {
		const v = vault({ [MINE]: "{ truncated", [THEIRS]: page(["a"]) });
		recordFork(rec());

		const out = await applyForkDecision(v, rec(), "keep-mine");

		expect(out.kind).toBe("refused");
		expect(out.why).toBe("damaged");
		expect(v.saved).toHaveLength(0);
	});
});

// ---- the two artifacts are not the same kind of object ----------------------

describe("restoring this device's revision unwraps the exact capture", () => {
	/**
	 * The outgoing leg nests a whole second copy of the page under
	 * `EXACT_OUTGOING_KEY`, and unknown top-level keys ride through the parser
	 * by design. Writing the parsed page straight back would put that nested
	 * copy into the user's live sidecar permanently.
	 */
	it("writes the nested capture, not the wrapper that carries it", async () => {
		// Nested the way the store writes it: the in-memory page, not the packed file form.
		const inner = parsePage(page(["exact-a", "exact-b"]), PAGE).data;
		const outer = { ...(JSON.parse(page(["rounded"])) as Record<string, unknown>) };
		outer["handwriting:exactOutgoing"] = inner;
		const v = vault({ [MINE]: JSON.stringify(outer), [THEIRS]: page(["a"]) });
		recordFork(rec());

		const out = await applyForkDecision(v, rec(), "keep-mine");

		expect(out.wrote).toBe(true);
		// The capture, not the wrapper's own rounded strokes.
		expect(v.saved[0]!.data.strokes.map((s) => s.id)).toEqual(["exact-a", "exact-b"]);
		// And the nested copy does not travel into the live page.
		const top = v.saved[0]!.data.unknownTop ?? {};
		expect(Object.keys(top)).not.toContain("handwriting:exactOutgoing");
	});

	it("still restores an artifact that carries no capture", async () => {
		const v = vault({ [MINE]: page(["plain-a"]), [THEIRS]: page(["a"]) });
		recordFork(rec());

		await applyForkDecision(v, rec(), "keep-mine");

		expect(v.saved[0]!.data.strokes.map((s) => s.id)).toEqual(["plain-a"]);
	});
});

// ---- finding forks the session did not see ----------------------------------

describe("forks are findable after a restart, because nothing else can find them", () => {
	const FOLDER = ".handwriting";
	const O = `${PAGE}.conflict-external-tok-outgoing.json`;
	const I = `${PAGE}.conflict-external-tok-incoming.json`;

	function scanVault(names: string[]): Vault {
		const v = vault({ [`${FOLDER}/${O}`]: page(["a"]), [`${FOLDER}/${I}`]: page(["b"]) });
		(v as ForkHost).list = async () => names;
		return v;
	}

	it("pairs the two legs off the filenames", async () => {
		const v = scanVault([O, I, `${PAGE}.json`, "notes.md"]);

		const found = await scanForForks(v, FOLDER);

		expect(found).toHaveLength(1);
		expect(found[0]!.pageId).toBe(PAGE);
		expect(found[0]!.outgoingPath).toBe(`${FOLDER}/${O}`);
		expect(found[0]!.incomingPath).toBe(`${FOLDER}/${I}`);
	});

	it("skips a pair missing a leg - one artifact is not a decision", async () => {
		const v = scanVault([O]);
		expect(await scanForForks(v, FOLDER)).toHaveLength(0);
	});

	it("ignores the live sidecar and anything else in the folder", async () => {
		const v = scanVault([`${PAGE}.json`, `${PAGE}.damaged-123.json`, "x.md"]);
		expect(await scanForForks(v, FOLDER)).toHaveLength(0);
	});

	it("does not displace a live record, which is the one that knows the note", async () => {
		const v = scanVault([O, I]);
		// The same pair, recorded live this session. The register holds one
		// entry per pair, so it is the same pair the scan finds.
		recordFork({ ...rec(), outgoingPath: `${FOLDER}/${O}`, incomingPath: `${FOLDER}/${I}` });

		await refreshForks(v, FOLDER);

		expect(listForks()).toHaveLength(1);
		// The in-session record knows the real note path; the scanned one only
		// knows the page id.
		expect(listForks()[0]!.path).toBe(NOTE);
	});

	it("adds a scanned fork the session never saw", async () => {
		const v = scanVault([O, I]);

		await refreshForks(v, FOLDER);

		expect(listForks()).toHaveLength(1);
		expect(listForks()[0]!.path).toBe(PAGE);
	});
});

// ---- the register -----------------------------------------------------------

describe("the register", () => {
	it("keeps one entry per page, newest first, and forgets on request", () => {
		recordFork({ ...rec(1), pageId: "p1" });
		recordFork({ ...rec(9), pageId: "p2" });
		recordFork({ ...rec(3), pageId: "p1" });

		expect(listForks().map((f) => f.pageId)).toEqual(["p2", "p1"]);
		expect(listForks().find((f) => f.pageId === "p1")!.at).toBe(3);

		forgetFork("p2");
		expect(listForks().map((f) => f.pageId)).toEqual(["p1"]);
	});
});

describe("a scanned fork is titled with the note or PDF, not a page id (#194)", () => {
	const FOLDER = ".handwriting";
	const O = `${PAGE}.conflict-external-tok-outgoing.json`;
	const I = `${PAGE}.conflict-external-tok-incoming.json`;
	const PDF = "Papers/intro.pdf";

	/** The real forkHostFor over an in-memory adapter, with the two lookups a caller may give. */
	function hostWith(lookups: { pathForNote?: (id: string) => string | null; pathForPdf?: (id: string) => Promise<string | null> }): ForkHost {
		const files = new Map([
			[`${FOLDER}/${O}`, page(["a"])],
			[`${FOLDER}/${I}`, page(["b"])],
		]);
		return forkHostFor({
			adapter: {
				read: async (p: string) => files.get(p) ?? "",
				stat: async (p: string) => (files.has(p) ? { mtime: 1 } : null),
				list: async () => ({ files: [O, I] }),
			},
			store: { saveNow: async () => {}, preserve: async () => null },
			...lookups,
		});
	}

	async function scanned(host: ForkHost): Promise<ForkRecord> {
		const found = await scanForForks(host, FOLDER);
		expect(found).toHaveLength(1);
		return found[0]!;
	}

	it("a scanned note pair shows the note name", async () => {
		const host = hostWith({ pathForNote: (id) => (id === PAGE ? NOTE : null) });
		expect((await describeFork(host, await scanned(host))).path).toBe(NOTE);
	});

	it("a scanned PDF pair shows the PDF name", async () => {
		const host = hostWith({ pathForNote: () => null, pathForPdf: async (id) => (id === PAGE ? PDF : null) });
		expect((await describeFork(host, await scanned(host))).path).toBe(PDF);
	});

	it("an id nothing knows shows the id", async () => {
		for (const host of [hostWith({}), hostWith({ pathForNote: () => null, pathForPdf: async () => null })]) {
			expect((await describeFork(host, await scanned(host))).path).toBe(PAGE);
		}
	});

	it("after a restart, a note nothing has loaded is named from the census (the audit's first trigger)", async () => {
		// The register is empty, as it is at startup; the only source of the
		// name is the ownership census the host was given, not an open note.
		resetForks();
		const census = new Map([[PAGE, NOTE]]);
		const host = hostWith({ pathForNote: (id) => census.get(id) ?? null });
		await refreshForks(host, FOLDER);
		const [only] = listForks();
		expect(only!.path).toBe(PAGE);
		expect((await describeFork(host, only!)).path).toBe(NOTE);
	});

	it("a lookup that throws leaves the id, and does not hide the entry", async () => {
		const host = hostWith({
			pathForNote: () => null,
			pathForPdf: async () => {
				throw new Error("sidecar unreadable");
			},
		});
		expect((await describeFork(host, await scanned(host))).path).toBe(PAGE);
	});

	it("a live-recorded pair keeps its own path, whatever the lookup says", async () => {
		const host = hostWith({ pathForNote: () => "Other/note.md", pathForPdf: async () => PDF });
		expect((await describeFork(host, rec())).path).toBe(NOTE);
	});
});
