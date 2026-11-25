import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
		Notice: class {
			hide(): void {
				/* no-op */
			}
		},
	};
});

import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import type { PageData } from "../model/PageData";
import { setDiagnosticsEnabled } from "./DiagSwitch";
import { clearInlinePenTrace, formatInlinePenTrace } from "../inline/InlinePenRouterTrace";

/** Issue 66 row: each page-id write the plugin makes to a note's text, the first claim and the duplicate's new id. */
const note = (id: string): string => `---\nhandwriting-page-id: ${id}\n---\nbody text\n`;
const ID = "a1b2c3d4-0000-4000-8000-0000000000c1";

function rig(opts: { active?: string | null; lastOpen?: string[] } = {}) {
	const activeReads = vi.fn(() => (opts.active ? { path: opts.active } : null));
	const lastOpenReads = vi.fn(() => opts.lastOpen ?? []);
	const transfers = vi.fn();
	const declaims = vi.fn();
	const repairs = vi.fn(async () => {});
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
	const notes = new Map<string, string>();
	const indexed = new Map<string, string | null>();
	inlineInk.attachHost({
		readPageId: (p: string) => indexed.get(p) ?? null,
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: (id: string) => store.load(id),
		scheduleSidecar: (id: string, p: PageData) => store.schedule(id, p),
		scheduleSidecarNow: (id: string, p: PageData) => store.saveNow(id, p),
		prepareExternalAdoption: (id: string, outgoing: PageData) => store.prepareExternalAdoption(id, outgoing),
		acceptExternalAdoption: (prepared: never) => store.acceptExternalAdoption(prepared),
		notify: () => {},
	} as never);
	const files = new Map<string, { path: string; basename: string }>();
	const file = (path: string) => {
		let f = files.get(path);
		if (!f) {
			f = { path, basename: path.replace(/\.md$/, "") };
			files.set(path, f);
		}
		return f;
	};
	const self = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		resolvingDuplicates: new Set<string>(),
		store,
		app: {
			vault: {
				getFileByPath: (p: string) => (notes.has(p) ? file(p) : null),
				process: async (f: { path: string }, fn: (data: string) => string) => {
					if (!notes.has(f.path)) throw new Error(`ENOENT: no such file, open '${f.path}'`);
					const next = fn(notes.get(f.path)!);
					notes.set(f.path, next);
					const m = /handwriting-page-id:\s*(\S+)/.exec(next);
					indexed.set(f.path, m ? m[1]! : null);
					return next;
				},
			},
			metadataCache: {
				getFileCache: (f: { path: string }) => ({ frontmatter: notes.get(f.path)?.startsWith("---") ? {} : undefined }),
				getCache: (p: string) => ({ frontmatter: indexed.get(p) ? { "handwriting-page-id": indexed.get(p) } : {} }),
			},
			...("active" in opts || "lastOpen" in opts ? { workspace: { getActiveFile: activeReads, getLastOpenFiles: lastOpenReads } } : {}),
		},
		pageIds: { register: () => ({ kind: "registered" }), snapshot: () => ({}), owner: () => undefined, transfer: transfers },
		declaimLater: declaims,
		resolveDuplicate: repairs,
		pageIdWatchReady: false,
		settings: { cameras: {}, pageOwners: {} },
		settingsDirty: false,
		settingsTimer: null,
		flushSettings: async () => {},
	});
	const proto = HandwritingPlugin.prototype as unknown as {
		claimNotePageId: (path: string, proposed: string, guard?: unknown) => Promise<{ pageId: string }>;
		resolveDuplicate: (copy: string, id: string, owner: string) => Promise<void>;
		resolveIdentityCollision: (path: string, id: string, v: { kind: "duplicate"; ownerPath: string }) => void;
	};
	return {
		notes,
		indexed,
		store,
		activeReads,
		lastOpenReads,
		transfers,
		declaims,
		repairs,
		claim: (path: string, proposed: string, guard?: unknown) => proto.claimNotePageId.call(self, path, proposed, guard),
		resolve: (copy: string, id: string, owner: string) => proto.resolveDuplicate.call(self, copy, id, owner),
		collide: (copy: string, id: string, owner: string) => proto.resolveIdentityCollision.call(self, copy, id, { kind: "duplicate", ownerPath: owner }),
		put: (path: string, text: string) => {
			notes.set(path, text);
			indexed.set(path, /handwriting-page-id:\s*(\S+)/.exec(text)?.[1] ?? null);
		},
	};
}

const rows = () =>
	formatInlinePenTrace()
		.split("\n")
		.filter((line) => /ms {2}page-id-write /.test(line));

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	setDiagnosticsEnabled(true);
	clearInlinePenTrace();
});
afterEach(() => {
	setDiagnosticsEnabled(false);
	clearInlinePenTrace();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("issue 66 page-id-write row", () => {
	it("a claim that writes the id line writes one row, changed=yes, with no path or id", async () => {
		const r = rig();
		r.put("pen66/fresh.md", "just text\n");
		await r.claim("pen66/fresh.md", ID);
		expect(r.notes.get("pen66/fresh.md"), "premise: the id line was written").toContain(ID);
		const got = rows();
		expect(got).toHaveLength(1);
		expect(got[0]).toContain("claim, changed=yes");
		expect(got[0], "no path or id in the row").not.toMatch(/pen66|fresh|a1b2c3d4/);
	});

	it("a claim that finds an id already there writes changed=no", async () => {
		const r = rig();
		r.put("pen66/has-id.md", note(ID));
		await r.claim("pen66/has-id.md", "a1b2c3d4-0000-4000-8000-0000000000c2");
		expect(rows()).toEqual([expect.stringContaining("claim, changed=no")]);
	});

	it("a claim the guard refuses throws and writes no row", async () => {
		const r = rig();
		r.put("pen66/guarded.md", "just text\n");
		const guard = { file: {}, markdown: "other", current: () => true };
		await expect(r.claim("pen66/guarded.md", ID, guard)).rejects.toThrow();
		expect(rows()).toHaveLength(0);
	});

	it("a duplicate given its own id writes one reassign row, changed=yes", async () => {
		const r = rig();
		r.put("pen66/x.md", note(ID));
		r.put("pen66/x 2.md", note(ID));
		await r.resolve("pen66/x 2.md", ID, "pen66/x.md");
		expect(r.indexed.get("pen66/x 2.md"), "premise: the copy took a new id").not.toBe(ID);
		expect(rows()).toEqual([expect.stringContaining("reassign, changed=yes")]);
	});
});

/** The duplicate repair's rows and the page-id write between them, as `type | note`. */
const repairRows = () =>
	formatInlinePenTrace()
		.split("\n")
		.map((line) => /ms {2}(duplicate-repair|page-id-write) .*\) {2}(.*)$/.exec(line))
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => `${m[1]} | ${m[2]}`);

describe("issue 66 duplicate-repair row", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("a repair of the active note writes start, the rewrite, the id write and end, in that order, with no path or id", async () => {
		const r = rig({ active: "pen66/d1 2.md" });
		r.put("pen66/d1.md", note(ID));
		r.put("pen66/d1 2.md", note(ID));
		await r.resolve("pen66/d1 2.md", ID, "pen66/d1.md");
		const fresh = r.indexed.get("pen66/d1 2.md");
		expect(fresh, "premise: the copy took a new id").not.toBe(ID);
		expect(repairRows()).toEqual([
			"duplicate-repair | start: copy active=yes, copy locked=no",
			"duplicate-repair | rewriting the copy's id line",
			"page-id-write | reassign, changed=yes",
			"duplicate-repair | end: repaired",
		]);
		const raw = formatInlinePenTrace()
			.split("\n")
			.filter((line) => /ms {2}duplicate-repair /.test(line))
			.join("\n");
		expect(raw, "no path or id in the rows").not.toMatch(/pen66|a1b2c3d4/);
		expect(raw.includes(String(fresh)), "the new id is not in the rows").toBe(false);
	});

	it("a repair of a note that is not the active one says active=no", async () => {
		const r = rig({ active: "pen66/d2.md" });
		r.put("pen66/d2.md", note(ID));
		r.put("pen66/d2 2.md", note(ID));
		await r.resolve("pen66/d2 2.md", ID, "pen66/d2.md");
		expect(repairRows()[0]).toBe("duplicate-repair | start: copy active=no, copy locked=no");
	});

	it("a repair the clone refuses writes start and a locked end naming the throw, and no rewrite", async () => {
		const r = rig();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(r.store, "clone").mockRejectedValueOnce(new Error("clone failed"));
		r.put("pen66/d3.md", note(ID));
		r.put("pen66/d3 2.md", note(ID));
		await r.resolve("pen66/d3 2.md", ID, "pen66/d3.md");
		expect(r.indexed.get("pen66/d3 2.md"), "premise: the copy kept the shared id").toBe(ID);
		expect(repairRows()).toEqual([
			"duplicate-repair | start: copy active=?, copy locked=no",
			"duplicate-repair | end: locked: flush or clone threw",
		]);
	});

	it("a queued save that will not flush ends locked, naming it; a copy locked before says so at start", async () => {
		const r = rig();
		r.put("pen66/e1.md", note(ID));
		r.put("pen66/e1 2.md", note(ID));
		inlineInk.markDuplicateLocked("pen66/e1 2.md", "pen66/e1.md");
		vi.spyOn(r.store, "hasQueuedWrite").mockReturnValue(true);
		const flush = vi.spyOn(r.store, "flushPage").mockResolvedValue(false);
		await r.resolve("pen66/e1 2.md", ID, "pen66/e1.md");
		expect(flush, "premise: the flush was tried").toHaveBeenCalled();
		expect(repairRows()).toEqual([
			"duplicate-repair | start: copy active=?, copy locked=yes",
			"duplicate-repair | end: locked: save not flushed",
		]);
	});

	it("a Slides clone that exists or cannot be read ends locked, naming which", async () => {
		for (const [n, slides] of [["e2", "exists"], ["e3", "unreadable"]] as const) {
			clearInlinePenTrace();
			const r = rig();
			vi.spyOn(r.store, "clone").mockResolvedValueOnce("none").mockResolvedValueOnce(slides);
			r.put(`pen66/${n}.md`, note(ID));
			r.put(`pen66/${n} 2.md`, note(ID));
			await r.resolve(`pen66/${n} 2.md`, ID, `pen66/${n}.md`);
			expect(repairRows()).toEqual([
				"duplicate-repair | start: copy active=?, copy locked=no",
				`duplicate-repair | end: locked: slides clone ${slides}`,
			]);
		}
	});

	it("a clone that already exists ends locked: clone exists", async () => {
		const r = rig();
		vi.spyOn(r.store, "clone").mockResolvedValueOnce("exists");
		r.put("pen66/e4.md", note(ID));
		r.put("pen66/e4 2.md", note(ID));
		await r.resolve("pen66/e4 2.md", ID, "pen66/e4.md");
		expect(repairRows()).toEqual([
			"duplicate-repair | start: copy active=?, copy locked=no",
			"duplicate-repair | end: locked: clone exists",
		]);
	});

	it("a copy declaring a newer format ends locked: newer format, after the write that changed nothing", async () => {
		const r = rig();
		r.put("pen66/e5.md", note(ID));
		r.put("pen66/e5 2.md", `---\nhandwriting-page-id: ${ID}\nhandwriting-version: 999\n---\nbody text\n`);
		await r.resolve("pen66/e5 2.md", ID, "pen66/e5.md");
		expect(r.indexed.get("pen66/e5 2.md"), "premise: the copy kept the shared id").toBe(ID);
		expect(repairRows()).toEqual([
			"duplicate-repair | start: copy active=?, copy locked=no",
			"duplicate-repair | rewriting the copy's id line",
			"page-id-write | reassign, changed=no",
			"duplicate-repair | end: locked: newer format",
		]);
	});

	it("a copy whose id line is gone by the write ends id line gone, not locked", async () => {
		const r = rig();
		r.put("pen66/e6.md", note(ID));
		r.put("pen66/e6 2.md", "just text\n");
		await r.resolve("pen66/e6 2.md", ID, "pen66/e6.md");
		expect(repairRows()).toEqual([
			"duplicate-repair | start: copy active=?, copy locked=no",
			"duplicate-repair | rewriting the copy's id line",
			"page-id-write | reassign, changed=no",
			"duplicate-repair | end: id line gone",
		]);
	});

	it("a rewrite that throws still ends, naming the throw", async () => {
		const r = rig();
		vi.spyOn(r.store, "clone").mockImplementation(async () => {
			r.notes.delete("pen66/e7 2.md");
			return "none";
		});
		r.put("pen66/e7.md", note(ID));
		r.put("pen66/e7 2.md", note(ID));
		await expect(r.resolve("pen66/e7 2.md", ID, "pen66/e7.md")).rejects.toThrow(/ENOENT/);
		expect(repairRows()).toEqual([
			"duplicate-repair | start: copy active=?, copy locked=no",
			"duplicate-repair | rewriting the copy's id line",
			"duplicate-repair | end: threw",
		]);
	});

	it("with recording off a repair reads no active note and writes no row; with it on it reads it", async () => {
		setDiagnosticsEnabled(false);
		const off = rig({ active: "pen66/d4 2.md" });
		off.put("pen66/d4.md", note(ID));
		off.put("pen66/d4 2.md", note(ID));
		await off.resolve("pen66/d4 2.md", ID, "pen66/d4.md");
		expect(off.indexed.get("pen66/d4 2.md"), "premise: the repair ran").not.toBe(ID);
		expect(off.activeReads, "no active-note read while off").not.toHaveBeenCalled();
		setDiagnosticsEnabled(true);
		expect(repairRows(), "no row from the off repair").toHaveLength(0);
		const on = rig({ active: "pen66/d5 2.md" });
		on.put("pen66/d5.md", note(ID));
		on.put("pen66/d5 2.md", note(ID));
		await on.resolve("pen66/d5 2.md", ID, "pen66/d5.md");
		expect(on.activeReads, "the active-note read while on").toHaveBeenCalled();
	});
});

const ID2 = "a1b2c3d4-0000-4000-8000-0000000000c2";
/** The duplicate sighting rows, as their note. */
const seenRows = () =>
	formatInlinePenTrace()
		.split("\n")
		.map((line) => /ms {2}duplicate-seen .*\) {2}(.*)$/.exec(line))
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => m[1]);

describe("issue 66 duplicate-seen row", () => {
	it("a sighting whose note open before carries the same id says yes, then repair, with no path or id", () => {
		const r = rig({ lastOpen: ["pen66/Untitled.md", "pen66/s1 2.md", "pen66/s1.md"] });
		r.put("pen66/s1.md", note(ID));
		r.put("pen66/s1 2.md", note(ID));
		r.collide("pen66/s1 2.md", ID, "pen66/s1.md");
		expect(r.repairs, "premise: the repair was started").toHaveBeenCalledTimes(1);
		expect(seenRows()).toEqual(["seen: same id as the note open before=yes, then repair"]);
		const raw = formatInlinePenTrace()
			.split("\n")
			.filter((line) => /ms {2}duplicate-seen /.test(line))
			.join("\n");
		expect(raw, "no path or id in the row").not.toMatch(/pen66|Untitled|a1b2c3d4/);
	});

	it("a sighting whose note open before carries another id says no", () => {
		const r = rig({ lastOpen: ["pen66/s2 2.md", "pen66/s2-other.md"] });
		r.put("pen66/s2.md", note(ID));
		r.put("pen66/s2 2.md", note(ID));
		r.put("pen66/s2-other.md", note(ID2));
		r.collide("pen66/s2 2.md", ID, "pen66/s2.md");
		expect(seenRows()).toEqual(["seen: same id as the note open before=no, then repair"]);
	});

	it("an owner gone from the id hands it over: then transfer; no note open before says ?", () => {
		const r = rig({ lastOpen: ["pen66/s3 2.md"] });
		r.put("pen66/s3 2.md", note(ID));
		r.collide("pen66/s3 2.md", ID, "pen66/s3.md");
		expect(r.transfers, "premise: the id moved to the copy").toHaveBeenCalledTimes(1);
		expect(seenRows()).toEqual(["seen: same id as the note open before=?, then transfer"]);
	});

	it("a locked copy whose owner is leaving the id waits: then wait for owner", () => {
		const r = rig({ lastOpen: ["pen66/s4 2.md", "pen66/s4.md"] });
		r.put("pen66/s4.md", note(ID2));
		r.put("pen66/s4 2.md", note(ID));
		inlineInk.markDuplicateLocked("pen66/s4 2.md", "pen66/s4.md");
		r.collide("pen66/s4 2.md", ID, "pen66/s4.md");
		expect(r.declaims, "premise: the owner's grace started").toHaveBeenCalledTimes(1);
		expect(seenRows()).toEqual(["seen: same id as the note open before=no, then wait for owner"]);
	});

	it("with no workspace the sighting says ?", () => {
		const r = rig();
		r.put("pen66/s5.md", note(ID));
		r.put("pen66/s5 2.md", note(ID));
		r.collide("pen66/s5 2.md", ID, "pen66/s5.md");
		expect(seenRows()).toEqual(["seen: same id as the note open before=?, then repair"]);
	});

	it("with recording off a sighting reads no open-note list and writes no row; with it on it reads it", () => {
		setDiagnosticsEnabled(false);
		const off = rig({ lastOpen: ["pen66/s6 2.md", "pen66/s6.md"] });
		off.put("pen66/s6.md", note(ID));
		off.put("pen66/s6 2.md", note(ID));
		off.collide("pen66/s6 2.md", ID, "pen66/s6.md");
		expect(off.repairs, "premise: the sighting ran").toHaveBeenCalledTimes(1);
		expect(off.lastOpenReads, "no open-note list read while off").not.toHaveBeenCalled();
		setDiagnosticsEnabled(true);
		expect(seenRows(), "no row from the off sighting").toHaveLength(0);
		const on = rig({ lastOpen: ["pen66/s7 2.md", "pen66/s7.md"] });
		on.put("pen66/s7.md", note(ID));
		on.put("pen66/s7 2.md", note(ID));
		on.collide("pen66/s7 2.md", ID, "pen66/s7.md");
		expect(on.lastOpenReads, "the open-note list read while on").toHaveBeenCalled();
	});
});
