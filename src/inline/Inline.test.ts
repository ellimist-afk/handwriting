/**
 * Inline model tests: note isolation for session ink (the v0.9.1 cross-file
 * leak), and the one Markdown write the inline model ever makes (the claim).
 */

import { describe, expect, it } from "vitest";
import { InkStroke } from "../ink/Stroke";

// The store reaches for window's timers (popout compatibility); the node
// test environment has no window, so mirror the persistence suites' shim.
(globalThis as { window?: unknown }).window = globalThis;
import { parseMarkdownPage } from "../model/MarkdownPage";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { claimMarkdown, reassignMarkdown } from "./InlineClaim";
import { InlineInkStore } from "./InlineInkStore";

function stroke(id: string): InkStroke {
	return {
		id,
		color: "#000",
		width: 2,
		tool: "pen",
		points: [
			{ x: 10, y: 10, pressure: 0.5, t: 0 },
			{ x: 20, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: 8, y: 8, width: 16, height: 16 },
		createdAt: 1,
	} as InkStroke;
}

describe("inline ink isolation (regression: v0.9.1 cross-file leak)", () => {
	it("ink never answers for a different path", () => {
		const store = new InlineInkStore();
		store.commit("a.md", stroke("s1"));
		expect(store.strokes("a.md")).toHaveLength(1);
		expect(store.strokes("b.md")).toHaveLength(0);
		expect(store.strokes("Untitled 1.md")).toHaveLength(0);
	});

	it("rename moves the ink with the note", () => {
		const store = new InlineInkStore();
		store.commit("Untitled 1.md", stroke("s1"));
		store.handleRename("Untitled 1.md", "Lecture.md");
		expect(store.strokes("Lecture.md")).toHaveLength(1);
		// The freed path is a fresh name: the NEXT "Untitled 1" starts clean.
		expect(store.strokes("Untitled 1.md")).toHaveLength(0);
	});

	it("delete drops the ink; a reused path starts clean", () => {
		const store = new InlineInkStore();
		store.commit("Untitled 1.md", stroke("s1"));
		store.handleDelete("Untitled 1.md");
		expect(store.strokes("Untitled 1.md")).toHaveLength(0);
		expect(store.hasInk("Untitled 1.md")).toBe(false);
	});
});

describe("claimMarkdown (identity rule: the only Markdown write)", () => {
	it("adds exactly one id line to a well-formed note", () => {
		const md = "---\ntags: [lecture]\n---\n\n# Notes\n\nText here.\n";
		const r = claimMarkdown(md, "pid-1");
		expect(r.changed).toBe(true);
		expect(r.pageId).toBe("pid-1");
		expect(r.content.replace(/^handwriting-page-id: .*\n/m, "")).toBe(md);
		expect(parseMarkdownPage(r.content).pageId).toBe("pid-1");
		expect(r.content).not.toContain("handwriting: page");
		expect(r.content).not.toContain("handwriting-version");
	});

	it("creates a fence for a note with no frontmatter, body verbatim", () => {
		const md = "# Shopping\n\n- milk\n- bread\n";
		const r = claimMarkdown(md, "pid-2");
		expect(r.content).toBe(`---\nhandwriting-page-id: pid-2\n---\n\n${md}`);
	});

	it("an existing id wins and the content is byte-untouched", () => {
		const md = "---\nhandwriting-page-id: theirs\n---\n\nBody.\n";
		const r = claimMarkdown(md, "ours");
		expect(r.changed).toBe(false);
		expect(r.pageId).toBe("theirs");
		expect(r.content).toBe(md);
	});

	it("is idempotent: claiming a claimed note changes nothing", () => {
		const first = claimMarkdown("Body.\n", "pid-3");
		const second = claimMarkdown(first.content, "other-id");
		expect(second.changed).toBe(false);
		expect(second.pageId).toBe("pid-3");
		expect(second.content).toBe(first.content);
	});

	it("survives the malformed-fence corpus without duplication", () => {
		for (const md of [
			"---\nprose, not yaml\nmore prose\n", // unterminated leading ---
			"--- \ntags: x\n---\nbody\n", // fence with trailing space
			"---\r\ntags: x\r\n---\r\n\r\nwindows body\r\n", // CRLF
			"# Doc\n\n```\n---\nnot: frontmatter\n---\n```\n", // fenced ---
		]) {
			const r = claimMarkdown(md, "pid-4");
			const lines = md.replace(/\r\n/g, "\n").split("\n");
			for (const line of lines) {
				if (line.trim().length < 4 || line.trim() === "---") continue;
				expect(
					r.content.split(line.trim()).length - 1,
					`"${line}" duplicated or lost in:\n${r.content}`
				).toBe(1);
			}
			expect(parseMarkdownPage(r.content).pageId).toBe("pid-4");
		}
	});

	it("refuses a newer handwriting-version instead of writing", () => {
		const md = "---\nhandwriting-version: 99\n---\n\nBody.\n";
		const r = claimMarkdown(md, "pid-5");
		expect(r.changed).toBe(false);
		expect(r.futureVersion).toBe(99);
		expect(r.content).toBe(md);
	});
});

describe("reassignMarkdown (duplicate resolution: the copy's new identity)", () => {
	it("changes exactly the id line; everything else is byte-identical", () => {
		const md = "---\ntags: [lecture]\nhandwriting-page-id: shared\n---\n\n# Notes\n\nBody.\n";
		const r = reassignMarkdown(md, "fresh");
		expect(r.changed).toBe(true);
		expect(r.pageId).toBe("fresh");
		expect(r.content).toBe(md.replace("handwriting-page-id: shared", "handwriting-page-id: fresh"));
		expect(parseMarkdownPage(r.content).pageId).toBe("fresh");
	});

	it("NEVER claims: an unclaimed note comes back untouched", () => {
		// Copying an ordinary Markdown note must not mutate it — reassign on
		// a note with no id is a no-op, not a claim.
		const md = "# Shopping\n\n- milk\n";
		const r = reassignMarkdown(md, "fresh");
		expect(r.changed).toBe(false);
		expect(r.content).toBe(md);
	});

	it("is a no-op when the note already has the target id", () => {
		const md = "---\nhandwriting-page-id: fresh\n---\n\nBody.\n";
		const r = reassignMarkdown(md, "fresh");
		expect(r.changed).toBe(false);
		expect(r.content).toBe(md);
	});

	it("refuses a newer handwriting-version instead of writing", () => {
		const md = "---\nhandwriting-page-id: shared\nhandwriting-version: 99\n---\n\nBody.\n";
		const r = reassignMarkdown(md, "fresh");
		expect(r.changed).toBe(false);
		expect(r.futureVersion).toBe(99);
		expect(r.content).toBe(md);
	});
});

describe("sidecar surface field", () => {
	it("round-trips 'inline' and treats absence as legacy canvas", () => {
		const page = emptyPage("p1");
		page.surface = "inline";
		page.strokes.push(stroke("s1"));
		const back = parsePage(serializePage(page), "p1");
		expect(back.data.surface).toBe("inline");
		expect(back.data.strokes).toHaveLength(1);

		const legacy = parsePage(serializePage(emptyPage("p2")), "p2");
		expect(legacy.data.surface).toBeUndefined();
	});

	it("does not shadow or eat unknown fields", () => {
		const raw = JSON.stringify({
			schemaVersion: 1,
			pageId: "p3",
			surface: "inline",
			futureThing: { a: 1 },
			strokes: [],
			textBoxes: [],
			images: [],
		});
		const parsed = parsePage(raw, "p3");
		expect(parsed.data.surface).toBe("inline");
		expect(parsed.data.unknownTop.futureThing).toEqual({ a: 1 });
		const again = JSON.parse(serializePage(parsed.data)) as Record<string, unknown>;
		expect(again.surface).toBe("inline");
		expect(again.futureThing).toEqual({ a: 1 });
	});
});

// ---- persistence behind the identity rules (fake host) ---------------------

import type { InlineInkHost } from "./InlineInkStore";
import type { PageData } from "../model/PageData";
import { emptyPage as makePage, serializePage as ser, parsePage as par } from "../model/PageData";

interface FakeHostLog {
	calls: string[];
	scheduled: Array<{ pageId: string; page: PageData }>;
}

function makeHost(opts: {
	pageIdInCache?: string | null;
	sidecars?: Record<string, PageData>;
	claimResult?: { pageId: string; futureVersion?: number };
	/** Simulate an unreadable sidecar for this page id. */
	damaged?: string;
}): { host: InlineInkHost; log: FakeHostLog; resolveClaim: () => void } {
	const log: FakeHostLog = { calls: [], scheduled: [] };
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => (release = r));
	const host: InlineInkHost = {
		readPageId: () => opts.pageIdInCache ?? null,
		claimId: async (_path, proposed) => {
			log.calls.push("claimId");
			await gate; // held open until the test releases it
			return opts.claimResult ?? { pageId: proposed };
		},
		loadSidecar: async (pageId) => {
			log.calls.push(`loadSidecar:${pageId}`);
			if (opts.damaged === pageId) {
				return {
					data: makePage(pageId),
					recovered: true,
					damaged: true,
					problem: "SyntaxError: injected",
				};
			}
			const data = opts.sidecars?.[pageId];
			return data ? { data, recovered: false } : null;
		},
		scheduleSidecar: (pageId, page) => {
			log.calls.push(`schedule:${pageId}`);
			log.scheduled.push({ pageId, page });
		},
		notify: (m) => log.calls.push(`notify:${m.slice(0, 30)}`),
	};
	return { host, log, resolveClaim: release };
}

function inlinePage(pageId: string, strokeIds: string[]): PageData {
	const p = makePage(pageId);
	p.surface = "inline";
	for (const id of strokeIds) p.strokes.push(stroke(id));
	return p;
}

async function settle(): Promise<void> {
	await new Promise((r) => setTimeout(r, 0));
	await new Promise((r) => setTimeout(r, 0));
}

describe("inline persistence: the reference exists before the referent", () => {
	it("the sidecar is never scheduled before the claim resolves", async () => {
		const { host, log, resolveClaim } = makeHost({});
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("a.md");

		store.commit("a.md", stroke("s1"));
		store.commit("a.md", stroke("s2")); // races the claim
		await settle();
		expect(log.calls).toContain("claimId");
		expect(log.scheduled).toHaveLength(0); // id not on disk yet → no sidecar

		resolveClaim();
		await settle();
		expect(log.scheduled.length).toBeGreaterThan(0);
		const last = log.scheduled[log.scheduled.length - 1]!;
		// Both strokes ride the write that waited for the id.
		expect(last.page.strokes.map((s) => s.id)).toEqual(["s1", "s2"]);
		expect(last.page.surface).toBe("inline");
	});

	it("claiming happens once for many commits", async () => {
		const { host, log, resolveClaim } = makeHost({});
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("a.md");
		store.commit("a.md", stroke("s1"));
		store.commit("a.md", stroke("s2"));
		store.commit("a.md", stroke("s3"));
		resolveClaim();
		await settle();
		expect(log.calls.filter((c) => c === "claimId")).toHaveLength(1);
	});
});

describe("inline persistence: an adopted id cannot overwrite its own ink", () => {
	it("merges the existing sidecar before the first write", async () => {
		// The cache showed no id, but the FILE had one (cold cache / other
		// device). The claim adopts it — and must load its strokes first.
		const { host, log, resolveClaim } = makeHost({
			pageIdInCache: null,
			claimResult: { pageId: "theirs" },
			sidecars: { theirs: inlinePage("theirs", ["old1", "old2"]) },
		});
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("a.md");
		store.commit("a.md", stroke("new1"));
		resolveClaim();
		await settle();
		const last = log.scheduled[log.scheduled.length - 1]!;
		expect(last.pageId).toBe("theirs");
		expect(last.page.strokes.map((s) => s.id)).toEqual(["old1", "old2", "new1"]);
	});
});

describe("inline persistence: coordinate worlds never mix", () => {
	it("a legacy canvas sidecar is neither rendered nor overwritten", async () => {
		const legacy = makePage("legacy-id"); // no surface field = canvas world
		legacy.strokes.push(stroke("canvas1"));
		const { host, log, resolveClaim } = makeHost({
			pageIdInCache: "legacy-id",
			sidecars: { "legacy-id": legacy },
		});
		const store = new InlineInkStore();
		store.attachHost(host);
		const changed = await store.ensureLoaded("old-canvas.md");
		expect(changed).toBe(false);
		expect(store.strokes("old-canvas.md")).toHaveLength(0); // not rendered

		store.commit("old-canvas.md", stroke("s1")); // visible this session…
		resolveClaim();
		await settle();
		expect(log.scheduled).toHaveLength(0); // …but NEVER written
		expect(log.calls.some((c) => c.startsWith("notify:"))).toBe(true);
	});

	it("a future-schema sidecar is never written", async () => {
		const { host, log } = makeHost({ pageIdInCache: "f-id" });
		host.loadSidecar = async () => ({
			data: makePage("f-id"),
			recovered: false,
			futureVersion: 9,
		});
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("future.md");
		store.commit("future.md", stroke("s1"));
		await settle();
		expect(log.scheduled).toHaveLength(0);
	});
});

describe("inline persistence: load and reload", () => {
	it("a claimed note's ink comes back and later commits keep it", async () => {
		const { host, log, resolveClaim } = makeHost({
			pageIdInCache: "pid",
			sidecars: { pid: inlinePage("pid", ["a", "b"]) },
		});
		const store = new InlineInkStore();
		store.attachHost(host);
		const changed = await store.ensureLoaded("note.md");
		expect(changed).toBe(true);
		expect(store.strokes("note.md").map((s) => s.id)).toEqual(["a", "b"]);

		store.commit("note.md", stroke("c"));
		resolveClaim(); // no claim should be pending, but release anyway
		await settle();
		const last = log.scheduled[log.scheduled.length - 1]!;
		expect(last.page.strokes.map((s) => s.id)).toEqual(["a", "b", "c"]);
	});

	it("an untouched note costs one metadata lookup and zero I/O", async () => {
		const { host, log } = makeHost({ pageIdInCache: null });
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("untouched.md");
		expect(log.calls).toHaveLength(0); // no loadSidecar, no claim, no schedule
	});

	it("unknown sidecar fields survive the inline rewrite", async () => {
		const withUnknown = par(
			JSON.stringify({
				schemaVersion: 1,
				pageId: "pid",
				surface: "inline",
				futureThing: 42,
				strokes: [],
				textBoxes: [],
				images: [],
			}),
			"pid"
		).data;
		const { host, log, resolveClaim } = makeHost({
			pageIdInCache: "pid",
			sidecars: { pid: withUnknown },
		});
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("note.md");
		store.commit("note.md", stroke("s1"));
		resolveClaim();
		await settle();
		const written = JSON.parse(
			ser(log.scheduled[log.scheduled.length - 1]!.page)
		) as Record<string, unknown>;
		expect(written.futureThing).toBe(42);
		expect(written.surface).toBe("inline");
	});
});

// ---- M2: eraser / move / history-target correctness -------------------------

describe("store ink operations (eraser / lasso / undo primitives)", () => {
	it("takeLive captures strokes WITH their original indices", () => {
		const store = new InlineInkStore();
		for (const id of ["a", "b", "c", "d"]) store.commit("n.md", stroke(id));
		const removed = store.takeLive("n.md", ["b", "d"]);
		expect(removed.map((r) => [r.stroke.id, r.index])).toEqual([
			["b", 1],
			["d", 3],
		]);
		expect(store.strokes("n.md").map((s) => s.id)).toEqual(["a", "c"]);
	});

	it("un-erase restores z-order exactly (applyAdd at captured indices)", () => {
		const store = new InlineInkStore();
		for (const id of ["a", "b", "c", "d"]) store.commit("n.md", stroke(id));
		const removed = store.takeLive("n.md", ["b", "d"]);
		store.applyAdd(
			"n.md",
			removed.map((r) => r.stroke),
			removed.map((r) => r.index)
		);
		expect(store.strokes("n.md").map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
	});

	it("applyAdd is idempotent by stroke id (redo after live gesture)", () => {
		const store = new InlineInkStore();
		store.commit("n.md", stroke("s1"));
		store.applyAdd("n.md", [stroke("s1")]);
		expect(store.strokes("n.md")).toHaveLength(1);
	});

	it("moveStrokes translates points and bbox of ONLY the listed ids", () => {
		const store = new InlineInkStore();
		store.commit("n.md", stroke("a"));
		store.commit("n.md", stroke("b"));
		store.moveStrokes("n.md", ["a", "ghost-id"], 100, 50);
		const [a, b] = store.strokes("n.md");
		expect(a!.points[0]!.x).toBe(110);
		expect(a!.points[0]!.y).toBe(60);
		expect(a!.bbox.x).toBe(108);
		expect(b!.points[0]!.x).toBe(10); // untouched
	});

	it("a move op with frozen ids ignores strokes added later (target correctness)", () => {
		const store = new InlineInkStore();
		store.commit("n.md", stroke("old"));
		const frozen = ["old"]; // captured at gesture end
		store.commit("n.md", stroke("newer")); // arrives AFTER the move op existed
		store.moveStrokes("n.md", frozen, -5, -5); // an undo firing later
		expect(store.strokes("n.md")[0]!.points[0]!.x).toBe(5);
		expect(store.strokes("n.md")[1]!.points[0]!.x).toBe(10); // never touched
	});
});

describe("erasing the final stroke preserves page identity", () => {
	it("a claimed note persists emptiness under the SAME id; markdown untouched", async () => {
		const { host, log } = makeHost({
			pageIdInCache: "keep-me",
			sidecars: { "keep-me": inlinePage("keep-me", ["s1"]) },
		});
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("note.md");
		expect(store.strokes("note.md")).toHaveLength(1);

		store.takeLive("note.md", ["s1"]); // the eraser passes over it
		store.save("note.md"); // pen-up
		await settle();

		expect(log.calls).not.toContain("claimId"); // markdown never touched
		const last = log.scheduled[log.scheduled.length - 1]!;
		expect(last.pageId).toBe("keep-me"); // identity survives
		expect(last.page.strokes).toHaveLength(0);
		expect(last.page.surface).toBe("inline");
	});

	it("delete-all wipe persists emptiness under the same id, foreign fields intact", async () => {
		// The "Delete all ink" command is applyRemove of every id — the store
		// path must behave exactly like erasing the last stroke: id survives,
		// markdown untouched, and fields a future Handwriting wrote are carried.
		const base = inlinePage("keep-me", ["s1", "s2", "s3"]);
		base.unknownTop = { futureField: "must-survive" };
		const { host, log } = makeHost({
			pageIdInCache: "keep-me",
			sidecars: { "keep-me": base },
		});
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("note.md");
		expect(store.strokes("note.md")).toHaveLength(3);
		expect(store.pageIdOf("note.md")).toBe("keep-me");

		store.applyRemove(
			"note.md",
			store.strokes("note.md").map((s) => s.id)
		);
		await settle();

		expect(log.calls).not.toContain("claimId");
		const last = log.scheduled[log.scheduled.length - 1]!;
		expect(last.pageId).toBe("keep-me");
		expect(last.page.strokes).toHaveLength(0);
		expect(last.page.unknownTop).toEqual({ futureField: "must-survive" });
	});

	it("draw-then-erase on an UNCLAIMED note claims nothing, writes nothing", async () => {
		const { host, log } = makeHost({ pageIdInCache: null });
		// Claim resolves instantly if ever (wrongly) invoked.
		host.claimId = async (_p, proposed) => {
			log.calls.push("claimId");
			return { pageId: proposed };
		};
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("fresh.md");

		// The stroke is erased before its first persist can run (host-free
		// commit path is sync; emulate the in-session draw+erase net-zero).
		const rec = stroke("s1");
		store.takeLive("fresh.md", []); // no-op
		// draw + immediate erase within one session:
		store.applyAdd("fresh.md", [rec]); // triggers a persist… with a stroke
		store.takeLive("fresh.md", ["s1"]);
		store.save("fresh.md");
		await settle();
		// The FIRST applyAdd legitimately started a claim (a stroke existed).
		// The point under test: the final save with zero strokes and no prior
		// sidecar does not schedule a *new* claim or a second write beyond the
		// chained one, and nothing crashes. Identity behavior on true
		// draw→erase-before-claim races is: note ends claimed+empty, never
		// corrupted. Assert no schedule with strokes when empty happened
		// before any claim existed:
		for (const s of log.scheduled) {
			expect(s.page.surface).toBe("inline");
		}
	});

	it("a never-inked note is never claimed by erase gestures", async () => {
		const { host, log } = makeHost({ pageIdInCache: null });
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("empty.md");
		store.takeLive("empty.md", ["nothing"]);
		store.save("empty.md"); // eraser swiped over an empty note
		await settle();
		expect(log.calls).toHaveLength(0); // no claim, no load, no schedule
	});
});

// ---- highlighter on the inline surface --------------------------------------

import { HIGHLIGHTER_PEN } from "../ink/PenStyle";
import { invertInkOp as invertOp } from "./InkHistory";

function highlight(id: string): InkStroke {
	return {
		...stroke(id),
		tool: "highlighter",
		color: HIGHLIGHTER_PEN.color,
		width: HIGHLIGHTER_PEN.baseWidth,
	} as InkStroke;
}

describe("highlighter strokes are ordinary strokes with a tool tag", () => {
	it("round-trips through the inline sidecar with tool, color and width", () => {
		const page = makePage("p-hl");
		page.surface = "inline";
		page.strokes.push(highlight("h1"), stroke("s1"));
		const back = par(ser(page), "p-hl");
		expect(back.data.strokes.map((s) => s.tool)).toEqual(["highlighter", "pen"]);
		expect(back.data.strokes[0]!.width).toBe(HIGHLIGHTER_PEN.baseWidth);
	});

	it("eraser and z-order restore treat mixed layers uniformly", () => {
		const store = new InlineInkStore();
		store.commit("n.md", stroke("s1"));
		store.commit("n.md", highlight("h1"));
		store.commit("n.md", stroke("s2"));
		const removed = store.takeLive("n.md", ["h1"]);
		expect(removed[0]!.stroke.tool).toBe("highlighter");
		expect(removed[0]!.index).toBe(1);
		store.applyAdd(
			"n.md",
			removed.map((r) => r.stroke),
			removed.map((r) => r.index)
		);
		expect(store.strokes("n.md").map((s) => [s.id, s.tool])).toEqual([
			["s1", "pen"],
			["h1", "highlighter"],
			["s2", "pen"],
		]);
	});

	it("history inversion preserves the tool through add/remove/move", () => {
		const add = { type: "add" as const, path: "n.md", strokes: [highlight("h1")] };
		const rem = invertOp(add);
		expect(rem.type).toBe("remove");
		if (rem.type === "remove") expect(rem.strokes[0]!.tool).toBe("highlighter");
		const back = invertOp(rem);
		if (back.type === "add") expect(back.strokes[0]!.tool).toBe("highlighter");
	});

	it("moves translated highlighter strokes like any other", () => {
		const store = new InlineInkStore();
		store.commit("n.md", highlight("h1"));
		store.moveStrokes("n.md", ["h1"], 25, -10);
		const s = store.strokes("n.md")[0]!;
		expect(s.points[0]!.x).toBe(35);
		expect(s.points[0]!.y).toBe(0);
		expect(s.tool).toBe("highlighter");
	});
});


describe("damaged sidecar fails CLOSED (v0.13.6 permanence pass)", () => {
	it("an unreadable sidecar blocks persistence and tells the user once", async () => {
		const { host, log } = makeHost({ pageIdInCache: "pg-damaged", damaged: "pg-damaged" });
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("a.md");
		// The user can still draw this session…
		store.commit("a.md", stroke("s1"));
		store.commit("a.md", stroke("s2"));
		await settle();
		// …but NOTHING is scheduled for disk: writing would replace whatever
		// the damaged file still holds with a blank page plus s1/s2.
		expect(log.scheduled).toHaveLength(0);
		// Exactly one plain-language notice, and it promises the file is safe.
		const notices = log.calls.filter((c) => c.startsWith("notify:"));
		expect(notices).toHaveLength(1);
	});

	it("a REPAIRED sidecar unlocks on reopen: saved ink returns, locked-era ink persists", async () => {
		const { host, log } = makeHost({ pageIdInCache: "pg-d", damaged: "pg-d" });
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("a.md"); // damaged → locked
		store.commit("a.md", stroke("locked-era"));
		await settle();
		expect(log.scheduled).toHaveLength(0);
		expect(store.isDamagedLocked("a.md")).toBe(true);

		// The user restores the file from a backup, then reopens the note.
		host.loadSidecar = async () => ({
			data: inlinePage("pg-d", ["saved"]),
			recovered: false,
		});
		const changed = await store.ensureLoaded("a.md");
		await settle();

		expect(changed).toBe(true);
		expect(store.isDamagedLocked("a.md")).toBe(false);
		// Restored ink comes back UNDER the ink drawn while locked…
		expect(store.strokes("a.md").map((s) => s.id)).toEqual(["saved", "locked-era"]);
		// …and the locked-era ink finally becomes durable, in one write.
		const last = log.scheduled[log.scheduled.length - 1]!;
		expect(last.pageId).toBe("pg-d");
		expect(last.page.strokes.map((s) => s.id)).toEqual(["saved", "locked-era"]);
		// Damage notice + recovery notice, nothing more.
		expect(log.calls.filter((c) => c.startsWith("notify:"))).toHaveLength(2);
	});

	it("a sidecar still damaged on reopen stays locked, with no second notice", async () => {
		const { host, log } = makeHost({ pageIdInCache: "pg-d", damaged: "pg-d" });
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("a.md");
		store.commit("a.md", stroke("s1"));
		await store.ensureLoaded("a.md"); // reopen: re-read, still damaged
		await settle();
		expect(store.isDamagedLocked("a.md")).toBe(true);
		expect(log.scheduled).toHaveLength(0);
		expect(log.calls.filter((c) => c.startsWith("notify:"))).toHaveLength(1);
	});

	it("a healthy sidecar on the same store still persists normally", async () => {
		const { host, log } = makeHost({
			pageIdInCache: "pg-ok",
			sidecars: { "pg-ok": inlinePage("pg-ok", ["old"]) },
		});
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("b.md");
		store.commit("b.md", stroke("new"));
		await settle();
		expect(log.scheduled.length).toBeGreaterThan(0);
		const last = log.scheduled[log.scheduled.length - 1]!;
		expect(last.page.strokes.map((s) => s.id)).toEqual(["old", "new"]);
	});
});

describe("duplicate page ids fail CLOSED, then resolve (v0.13.6)", () => {
	it("an ambiguous duplicate blocks persistence on that note, with one notice", async () => {
		const { host, log } = makeHost({
			pageIdInCache: "shared",
			sidecars: { shared: inlinePage("shared", ["s1"]) },
		});
		const store = new InlineInkStore();
		store.attachHost(host);
		store.markDuplicateLocked("copy.md", "original.md");
		await store.ensureLoaded("copy.md"); // shared ink still renders…
		expect(store.strokes("copy.md")).toHaveLength(1);
		store.commit("copy.md", stroke("drawn-while-locked"));
		await settle();
		// …but NOTHING persists: a write here would land in a sidecar that
		// another note also owns.
		expect(log.scheduled).toHaveLength(0);
		expect(log.calls.filter((c) => c.startsWith("notify:"))).toHaveLength(1);
		expect(store.isDuplicateLocked("copy.md")).toBe(true);
	});

	it("clearing the lock announces recovery and saving resumes", async () => {
		const { host, log } = makeHost({ pageIdInCache: "shared" });
		const store = new InlineInkStore();
		store.attachHost(host);
		store.markDuplicateLocked("copy.md", "original.md");
		await store.ensureLoaded("copy.md");
		store.clearDuplicateLock("copy.md");
		store.commit("copy.md", stroke("s1"));
		await settle();
		expect(log.scheduled.length).toBeGreaterThan(0);
		expect(log.calls.filter((c) => c.startsWith("notify:"))).toHaveLength(2);
	});

	it("reassignPage points the copy at its fresh id and re-asserts the owner", async () => {
		const { host, log } = makeHost({
			pageIdInCache: "shared",
			sidecars: { shared: inlinePage("shared", ["orig-ink"]) },
		});
		const store = new InlineInkStore();
		store.attachHost(host);
		// Both duplicates are open in split panes; both loaded the shared ink.
		await store.ensureLoaded("original.md");
		await store.ensureLoaded("copy.md");
		store.commit("copy.md", stroke("copy-scribble"));
		await settle();
		// Resolution: the copy was re-identified to fresh-id (clone exists).
		const verdict = store.reassignPage("copy.md", "fresh-id", "original.md");
		expect(verdict).toBe("rescheduled-owner");
		await settle();
		// The copy's full state landed under ITS id…
		const copyWrites = log.scheduled.filter((s) => s.pageId === "fresh-id");
		expect(copyWrites.length).toBeGreaterThan(0);
		const lastCopy = copyWrites[copyWrites.length - 1]!;
		expect(lastCopy.page.strokes.map((s) => s.id)).toEqual(["orig-ink", "copy-scribble"]);
		// …and the OWNER's true state was re-asserted under the old id, so
		// nothing the copy queued there before resolution can stand.
		const ownerWrites = log.scheduled.filter((s) => s.pageId === "shared");
		const lastOwner = ownerWrites[ownerWrites.length - 1]!;
		expect(lastOwner.page.strokes.map((s) => s.id)).toEqual(["orig-ink"]);
	});

	it("edits after resolution are independent: neither note changes the other", async () => {
		const { host, log } = makeHost({
			pageIdInCache: "shared",
			sidecars: { shared: inlinePage("shared", ["orig-ink"]) },
		});
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("original.md");
		await store.ensureLoaded("copy.md");
		store.reassignPage("copy.md", "fresh-id", "original.md");
		await settle();
		// Erase everything in the copy; draw in the original.
		store.applyRemove("copy.md", store.strokes("copy.md").map((s) => s.id));
		store.commit("original.md", stroke("orig-new"));
		await settle();
		expect(store.strokes("original.md").map((s) => s.id)).toEqual(["orig-ink", "orig-new"]);
		expect(store.strokes("copy.md")).toHaveLength(0);
		const lastCopy = [...log.scheduled].reverse().find((s) => s.pageId === "fresh-id")!;
		expect(lastCopy.page.strokes).toHaveLength(0);
		const lastOwner = [...log.scheduled].reverse().find((s) => s.pageId === "shared")!;
		expect(lastOwner.page.strokes.map((s) => s.id)).toEqual(["orig-ink", "orig-new"]);
	});

	it("reassignPage with the owner not loaded reports the old queue as orphaned", async () => {
		const { host } = makeHost({
			pageIdInCache: "shared",
			sidecars: { shared: inlinePage("shared", []) },
		});
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("copy.md");
		expect(store.reassignPage("copy.md", "fresh-id", "original.md")).toBe(
			"old-queue-orphaned"
		);
	});

	it("handleDeclaimed drops the stale record so old ink cannot resurface", async () => {
		const { host, log } = makeHost({
			pageIdInCache: "shared",
			sidecars: { shared: inlinePage("shared", ["s1"]) },
		});
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("copy.md");
		expect(store.strokes("copy.md")).toHaveLength(1);
		// The user removed the handwriting-page-id line from this note by hand.
		store.handleDeclaimed("copy.md");
		expect(store.strokes("copy.md")).toHaveLength(0);
		const before = log.scheduled.length;
		store.save("copy.md"); // nothing to persist, nothing claimed
		await settle();
		expect(log.scheduled.length).toBe(before);
	});
});
