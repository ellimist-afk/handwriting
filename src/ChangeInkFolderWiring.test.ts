/**
 * The WIRING of `changeInkFolder` (main.ts) - which callback goes in which
 * slot, and what each one actually touches.
 *
 * WHY THIS FILE EXISTS. `changeFolder` (InkFolder.ts) is well covered and so
 * are all six things the callbacks delegate to - `migrateInkFolder`,
 * `useInkFolder`, `holdWrites`, `releaseWrites`, `flush`, `settle`. What no
 * test named until now is the ASSEMBLY: that `holdWrites` is wired to the
 * store's hold and not to something else, that `settle` drains BOTH the
 * inline store and the sidecar queue, that `migrate` is handed the vault
 * adapter, that `persist` writes the setting AND saves it. Every comment in
 * that method describes a data-loss bug the wiring already caused once. The
 * pieces were tested; the assembly moves someone's entire ink folder.
 *
 * HOW IT RUNS THE REAL CODE WITHOUT A PRODUCTION SEAM. `src/main.ts` cannot
 * be imported (it constructs a plugin) and must not be edited from here. So the method's own source is sliced out of `main.ts?raw` between
 * verbatim anchors and executed with its collaborators injected, exactly the
 * technique `LiveReloadTestHarness.ts` already uses for the live-reload poll.
 * Every boundary below is asserted, so a rename or a moved anchor fails this
 * file loudly instead of silently testing nothing.
 *
 * WHAT IS DELIBERATELY NOT PINNED HERE: the ORDER the callbacks fire in.
 * `changeFolder` decides that - hold before migrate, release in a `finally`,
 * persist only after - and it has its own tests. This file is faked at that
 * boundary on purpose, so a change in ordering policy breaks the file that
 * owns the policy rather than this one. What IS pinned is what each callback
 * does when called, and which of them the outcome branches leave unrun.
 */

import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import mainSource from "./main.ts?raw";
import { SYNC_ALL_TYPES_HINT } from "./main";
import { inkFolderSyncs, normalizeInkFolder } from "./persistence/InkFolder";

// ---- the slice, fail-closed ------------------------------------------------

const source = mainSource.replace(/\r\n/g, "\n");
const START = "\tasync changeInkFolder(raw: string): Promise<void> {";
const END = "\n\tprivate async loadSettings(";
expect(source.split(START), "changeInkFolder's declaration line moved").toHaveLength(2);
expect(source.split(END), "the method after changeInkFolder was renamed").toHaveLength(2);
const bodyStart = source.indexOf(START) + START.length;
const bodyEnd = source.indexOf(END, bodyStart);
expect(bodyEnd).toBeGreaterThan(bodyStart);
const closed = source.slice(bodyStart, bodyEnd).trimEnd();
expect(closed.endsWith("}"), "the slice did not end on the method's closing brace").toBe(true);
const BODY = closed.slice(0, -1);

// The six slots this file exists to pin. If one is renamed or removed the
// slice still compiles, so assert their presence rather than discovering a
// silently-passing suite later.
for (const slot of ["settle:", "holdWrites:", "releaseWrites:", "migrate:", "repoint:", "persist:"]) {
	expect(BODY, `the ${slot} wire is gone from changeInkFolder`).toContain(slot);
}

const compiled = transformSync(`async function run(raw: string): Promise<void> {${BODY}}`, {
	loader: "ts",
	target: "es2022",
}).code;

// ---- fakes -----------------------------------------------------------------

interface Outcome {
	kind: string;
	result?: { moved: number; skipped: number; unsupported?: boolean };
}
interface Steps {
	settle: () => Promise<boolean>;
	holdWrites?: () => void;
	releaseWrites?: () => void;
	migrate: (from: string, to: string) => Promise<unknown>;
	repoint: (to: string) => void;
	persist: (to: string) => Promise<void>;
}

interface Harness {
	steps: Steps;
	from: string;
	to: string;
	order: string[];
	notices: string[];
	settings: { inkFolder?: string };
	migrateArgs: unknown[][];
	adapter: object;
	/** A holder, not a number: callbacks are driven AFTER `run` returns. */
	saved: { n: number };
}

/**
 * Run the real method with `changeFolder` faked, so the outcome branch is
 * chosen by the test and the steps object is captured for inspection.
 */
async function run(
	raw: string,
	opts: {
		current?: string;
		outcome?: Outcome;
		inlineSettles?: boolean;
		storeBusyAfterFlush?: boolean;
	} = {}
): Promise<Harness> {
	const order: string[] = [];
	const notices: string[] = [];
	const migrateArgs: unknown[][] = [];
	const settings: { inkFolder?: string } = { inkFolder: "before" };
	const adapter = { name: "the vault adapter" };
	const saved = { n: 0 };
	let captured: { steps: Steps; from: string; to: string } | null = null;

	const store = {
		inkFolder: () => opts.current ?? "old",
		flush: async () => {
			order.push("store.flush");
		},
		get busy(): boolean {
			return opts.storeBusyAfterFlush ?? false;
		},
		holdWrites: () => void order.push("store.holdWrites"),
		releaseWrites: () => void order.push("store.releaseWrites"),
		useInkFolder: (to: string) => void order.push(`store.useInkFolder(${to})`),
	};
	const inlineInk = {
		settle: async () => {
			order.push("inlineInk.settle");
			return opts.inlineSettles ?? true;
		},
	};
	const changeFolder = async (steps: Steps, from: string, to: string): Promise<Outcome> => {
		captured = { steps, from, to };
		return opts.outcome ?? { kind: "moved", result: { moved: 3, skipped: 0 } };
	};
	const migrateInkFolder = async (...args: unknown[]): Promise<unknown> => {
		migrateArgs.push(args);
		order.push("migrateInkFolder");
		return { moved: 3, skipped: 0 };
	};
	class Notice {
		constructor(message: string) {
			notices.push(message);
		}
	}

	const make = new Function(
		"inlineInk",
		"changeFolder",
		"migrateInkFolder",
		"normalizeInkFolder",
		"inkFolderSyncs",
		"Notice",
		"SYNC_ALL_TYPES_HINT",
		`${compiled}; return run;`
	) as (...deps: unknown[]) => (raw: string) => Promise<void>;

	const fn = make(inlineInk, changeFolder, migrateInkFolder, normalizeInkFolder, inkFolderSyncs, Notice, SYNC_ALL_TYPES_HINT);
	const self = {
		store,
		app: { vault: { adapter } },
		settings,
		saveSettingsNow: () => {
			saved.n++;
			order.push("saveSettingsNow");
		},
	};
	await fn.call(self, raw);

	expect(captured, "changeFolder was never called").not.toBeNull();
	const c = captured as unknown as { steps: Steps; from: string; to: string };
	return { steps: c.steps, from: c.from, to: c.to, order, notices, settings, migrateArgs, adapter, saved };
}

// ---- what it hands to changeFolder ----------------------------------------

describe("changeInkFolder hands changeFolder the right from and to", () => {
	it("normalises the raw input and reads the current folder from the store", async () => {
		const h = await run("  Ink/Pages/  ", { current: "old-folder" });

		expect(h.from).toBe("old-folder");
		expect(h.to).toBe(normalizeInkFolder("  Ink/Pages/  "));
		// The real normaliser ran, not a passthrough.
		expect(h.to).not.toBe("  Ink/Pages/  ");
	});
});

// ---- each wire, driven -----------------------------------------------------

describe("each callback is wired to the thing it is supposed to reach", () => {
	it("settle drains the inline store AND the sidecar queue, in that order", async () => {
		const h = await run("next");

		expect(await h.steps.settle()).toBe(true);
		// Both halves, and the inline claims first: the comment in the method
		// says a debounced save still in its timer was the loss.
		expect(h.order).toEqual(["inlineInk.settle", "store.flush"]);
	});

	it("settle refuses when the inline store cannot settle, without flushing", async () => {
		const h = await run("next", { inlineSettles: false });

		expect(await h.steps.settle()).toBe(false);
		// Short-circuited: no flush, because there is no point draining a
		// queue that is about to be written to again.
		expect(h.order).toEqual(["inlineInk.settle"]);
	});

	it("settle refuses when the store is still busy after the flush", async () => {
		const h = await run("next", { storeBusyAfterFlush: true });

		expect(await h.steps.settle()).toBe(false);
		expect(h.order).toEqual(["inlineInk.settle", "store.flush"]);
	});

	// Separately, because they are separate wires: a hold that is passed and
	// a release that is not leaves the store unable to save for the rest of
	// the session, and one case covering both cannot tell you which broke.
	it("holdWrites reaches the store's own hold", async () => {
		const h = await run("next");

		h.steps.holdWrites?.();

		expect(h.order).toEqual(["store.holdWrites"]);
	});

	it("releaseWrites reaches the store's own release", async () => {
		const h = await run("next");

		h.steps.releaseWrites?.();

		expect(h.order).toEqual(["store.releaseWrites"]);
	});

	it("migrate is handed the VAULT ADAPTER and the folders changeFolder chose", async () => {
		const h = await run("next");

		await h.steps.migrate("from-here", "to-there");

		expect(h.migrateArgs).toHaveLength(1);
		// The adapter, not the app and not the store: migrateInkFolder lists
		// and renames files and cannot do either through anything else.
		expect(h.migrateArgs[0]).toEqual([h.adapter, "from-here", "to-there"]);
	});

	it("repoint moves the store, and only the store", async () => {
		const h = await run("next");

		h.steps.repoint("the-destination");

		expect(h.order).toEqual(["store.useInkFolder(the-destination)"]);
	});

	it("persist writes the setting AND saves it", async () => {
		const h = await run("next");

		await h.steps.persist("the-destination");

		// Both halves. Writing the field without saving loses the change on
		// the next load; saving without writing it saves the old value.
		expect(h.settings.inkFolder).toBe("the-destination");
		expect(h.saved.n).toBe(1);
		expect(h.order).toEqual(["saveSettingsNow"]);
	});
});

// ---- the branches, and what each leaves behind -----------------------------

describe("every outcome branch says the right thing and stops where it should", () => {
	it("unchanged says nothing at all", async () => {
		const h = await run("same", { outcome: { kind: "unchanged" } });

		expect(h.notices).toEqual([]);
	});

	it("busy tells the user to try again, and does not claim the folder moved", async () => {
		const h = await run("next", { outcome: { kind: "busy" } });

		expect(h.notices).toHaveLength(1);
		expect(h.notices[0]).toContain("still saving");
		expect(h.notices[0]).not.toContain("is now");
	});

	it("unsupported names the vault, not the ink", async () => {
		const h = await run("next", { outcome: { kind: "unsupported" } });

		expect(h.notices).toHaveLength(1);
		expect(h.notices[0]).toContain("cannot list files");
		expect(h.notices[0]).not.toContain("is now");
	});

	it("moved reports the count and stays quiet about skips when there are none", async () => {
		const h = await run("Ink", { outcome: { kind: "moved", result: { moved: 4, skipped: 0 } } });

		expect(h.notices).toHaveLength(1);
		expect(h.notices[0]).toContain("Moved 4 file(s)");
		expect(h.notices[0]).not.toContain("left behind");
	});

	it("moved names the files it could not move", async () => {
		const h = await run("Ink", { outcome: { kind: "moved", result: { moved: 4, skipped: 2 } } });

		expect(h.notices[0]).toContain("2 left behind (name already taken)");
	});

	it("warns when the destination is a dot-folder that will not sync", async () => {
		const hidden = await run(".ink", { outcome: { kind: "moved", result: { moved: 1, skipped: 0 } } });
		const plain = await run("ink", { outcome: { kind: "moved", result: { moved: 1, skipped: 0 } } });

		// The real `inkFolderSyncs` decides this, and the two arms differ -
		// without the pair, a warning that never appears would pass.
		expect(hidden.notices[0]).toContain("will not sync");
		expect(plain.notices[0]).not.toContain("will not sync");
	});
});
