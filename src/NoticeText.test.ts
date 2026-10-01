/**
 * Three notice texts that said something the plugin does not do. Each is driven from the real source in main.ts:
 * the piece under test is sliced out, compiled, and run against stand-ins for what it reads.
 *
 *  - the write-failure notice must say how many tries the store really makes, counted from the real write path;
 *  - the Delete all ink dialog must name the trash folder the copy will go to, from the store's own rule;
 *  - a PDF's or a slides deck's write-failure notice must name the file, not "an unnamed page".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { transformSync } from "esbuild";
import mainSource from "./main.ts?raw";
import { PageStore, WRITE_ATTEMPTS, WRITE_MAX_RETRIES } from "./persistence/PageStore";
import { FakeAdapter } from "./persistence/FakeAdapter";
import { emptyPage, serializePage } from "./model/PageData";

const main = mainSource.replace(/\r\n/g, "\n");
const NL = "\n";

function slice(from: string, to: string): string {
	expect(main.split(from), `${from} is in main.ts once`).toHaveLength(2);
	const at = main.indexOf(from);
	const end = main.indexOf(to, at);
	expect(end).toBeGreaterThan(at);
	return main.slice(at, end + to.length);
}

function compile(ts: string): string {
	return transformSync(ts, { loader: "ts" }).code;
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
});
afterEach(() => {
	vi.useRealTimers();
});

describe("write-failure notice (tries)", () => {
	it("names the number of attempts the real write path makes before it reports the failure", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const fake = new FakeAdapter();
		const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
		let raised: Array<[string, string]> = [];
		let attemptsAtReport = -1;
		store.onWriteError = (id, problem) => {
			raised.push([id, problem]);
			attemptsAtReport = fake.writeAttempts;
		};
		fake.failWriteTimes = 99;
		const page = emptyPage("p1");
		void serializePage(page);
		store.schedule("p1", page);
		for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(2000);
		expect(raised).toHaveLength(1);
		expect(attemptsAtReport).toBe(1 + WRITE_MAX_RETRIES);
		// "Your next change starts another try": the next edit writes again.
		store.schedule("p1", emptyPage("p1"));
		for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(2000);
		expect(fake.writeAttempts).toBeGreaterThan(attemptsAtReport);

		// The notice, as main.ts builds it, with the store's own constant.
		const callback = slice("this.store.onWriteError = (pageId, problem, preservedAs) => {", `${NL}\t\t};`);
		const shown: string[] = [];
		const ctx = { store: {} as Record<string, unknown>, noteNameFor: () => "n.md" };
		const js = compile(`${callback};`);
		new Function("Notice", "WRITE_ATTEMPTS", `${js}${NL}return this.store.onWriteError;`).call(
			ctx,
			class {
				constructor(m: string) {
					shown.push(m);
				}
			},
			WRITE_ATTEMPTS
		);
		(ctx.store.onWriteError as (a: string, b: string, c?: string) => void)("p1", "EIO", undefined);
		expect(shown[0]).not.toContain("keeps retrying");
		const words = ["zero", "one", "two", "three", "four", "five", "six"];
		expect(shown[0]).toContain(`after ${words[attemptsAtReport]} tries`);
		expect(shown[0]).toContain("The ink stays on screen; your next change starts another try.");
	});
});

describe("Delete all ink dialog", () => {
	class FakeEl {
		text = "";
		children: FakeEl[] = [];
		setText(t: string): void {
			this.text = t;
		}
		createEl(_tag: string, opts: { text?: string } = {}): FakeEl {
			const el = new FakeEl();
			el.text = opts.text ?? "";
			this.children.push(el);
			return el;
		}
		createDiv(): FakeEl {
			const el = new FakeEl();
			this.children.push(el);
			return el;
		}
		addEventListener(): void {}
		focus(): void {}
		empty(): void {}
	}

	/** Runs main.ts's real confirm step and modal class for one note, against a real store. */
	async function dialogText(noun: "note" | "PDF", where: "configured" | "other"): Promise<string> {
		const fake = new FakeAdapter();
		const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
		const home = where === "configured" ? ".handwriting/p1.json" : "handwriting/p1.json";
		fake.files.set(home, serializePage(emptyPage("p1")));
		fake.dirs.add(home.slice(0, home.lastIndexOf("/")));

		const cls = compile(slice("class ConfirmDeleteInkModal extends Modal {", `${NL}}${NL}`));
		const opened: Array<{ contentEl: FakeEl }> = [];
		const pending: Promise<unknown>[] = [];
		class Modal {
			titleEl = new FakeEl();
			contentEl = new FakeEl();
			constructor(public app: unknown) {}
			open(): void {
				pending.push((this as unknown as { onOpen(): Promise<void> }).onOpen());
				opened.push(this);
			}
		}
		const inlineInk = { strokes: () => [1, 2], pageIdOf: () => "p1" };
		const Ctor = new Function("Modal", `${cls}${NL}return ConfirmDeleteInkModal;`)(Modal);
		const ctx = { app: {}, store, confirmedDeleteAllInk: () => {} } as Record<string, unknown>;
		if (noun === "note") {
			const method = compile(`class T { ${slice("private confirmDeleteAllInk(target: DeleteAllTarget): void {", `${NL}\t}${NL}`)} }${NL}return T;`);
			const T = new Function("inlineInk", "ConfirmDeleteInkModal", method)(inlineInk, Ctor);
			Object.assign(ctx, { confirmDeleteAllInk: T.prototype.confirmDeleteAllInk });
			(ctx.confirmDeleteAllInk as (t: unknown) => void).call(ctx, { path: "n.md" });
		} else {
			// The PDF command builds its dialog inline; the modal is fed the store's answer the same way.
			new Ctor({}, 2, "PDF", () => {}, () => store.trashFolderFor("p1")).open();
		}
		await Promise.all(pending);
		expect(opened).toHaveLength(1);
		return opened[0]!.contentEl.children.map((c) => c.text).join(" ");
	}

	it("names the configured folder's trash for a note stored there", async () => {
		expect(await dialogText("note", "configured")).toContain(".handwriting/trash");
	});
	it("names the other well-known folder's trash for a note served from it", async () => {
		const text = await dialogText("note", "other");
		expect(text).toContain("handwriting/trash");
		expect(text).not.toContain(".handwriting/trash");
	});
	it("names the other folder's trash for a PDF served from it", async () => {
		const text = await dialogText("PDF", "other");
		expect(text).toContain("handwriting/trash");
		expect(text).not.toContain(".handwriting/trash");
	});
});

describe("noteNameFor names the file", () => {
	function nameFor(pageId: string, opts: { owners?: Record<string, string>; pdf?: Record<string, string> } = {}): string {
		const method = slice("private noteNameFor(pageId: string): string {", "\n\t}\n");
		const lookup = slice("private notePathFor(pageId: string): string | null {", "\n\t}\n");
		const js = compile(`class T { ${method} ${lookup} }\nreturn T;`);
		const Ctor = new Function("SLIDES_SIDECAR_SUFFIX", js)(".slides") as new () => { noteNameFor(id: string): string };
		const t = new Ctor() as unknown as Record<string, unknown>;
		const owners = opts.owners ?? {};
		t.pageIds = { owner: (id: string) => owners[id] ?? null };
		t.app = { vault: { getMarkdownFiles: () => [] } };
		t.recentPageIdFor = () => null;
		const roots = Object.keys(opts.pdf ?? {}).map((id) => ({ id, root: {} }));
		t.pdfIds = new Map(roots.map((r) => [r.root, r.id]));
		t.pdfFiles = new Map(roots.map((r) => [r.root, (opts.pdf ?? {})[r.id]]));
		return (t as unknown as { noteNameFor(id: string): string }).noteNameFor(pageId);
	}

	it("an open PDF's ink id gives the PDF's path", () => {
		expect(nameFor("abcdef123456-1", { pdf: { "abcdef123456-1": "Papers/a.pdf" } })).toBe("Papers/a.pdf");
	});
	it("a slides sidecar id gives the note that owns the deck", () => {
		expect(nameFor("11112222.slides", { owners: { "11112222": "Talks/deck.md" } })).toBe("Talks/deck.md");
	});
	it("a plain note id still gives the note", () => {
		expect(nameFor("11112222", { owners: { "11112222": "n.md" } })).toBe("n.md");
	});
	it("an id that resolves to nothing still degrades to the short id", () => {
		expect(nameFor("deadbeefcafe")).toContain("deadbeef");
	});
	it("the lookup half answers null for an id nothing knows, so a caller can fall back to the bare id (#194)", () => {
		const ctor = () => {
			const lookup = slice("private notePathFor(pageId: string): string | null {", "\n\t}\n");
			const js = compile(`class T { ${lookup} }\nreturn T;`);
			const Ctor = new Function("SLIDES_SIDECAR_SUFFIX", js)(".slides") as new () => Record<string, unknown>;
			const t = new Ctor();
			t.pageIds = { owner: (id: string) => (id === "11112222" ? "Talks/deck.md" : null) };
			t.app = { vault: { getMarkdownFiles: () => [] } };
			t.recentPageIdFor = () => null;
			t.pdfIds = new Map();
			t.pdfFiles = new Map();
			return t as unknown as { notePathFor(id: string): string | null };
		};
		expect(ctor().notePathFor("deadbeefcafe")).toBeNull();
		expect(ctor().notePathFor("11112222")).toBe("Talks/deck.md");
		expect(ctor().notePathFor("11112222.slides")).toBe("Talks/deck.md");
	});
});

describe("resolve-ink-fork wiring names a scanned pair (#194)", () => {
	// The two lookups main.ts hands forkHostFor, sliced out and run against stand-ins for `this`.
	const wiring = () => slice("pathForNote: (pageId) =>", "// A restored page goes through");
	function host(existing: string[] = ["Docs/a.pdf"], claims: Record<string, string[]> = { bbbb2222: ["Docs/a.pdf", "Docs/old.pdf"] }) {
		const calls = { notePathFor: [] as string[], readPdfPaths: [] as string[], pathForPageId: 0 };
		const self = {
			notePathFor: (id: string) => (calls.notePathFor.push(id), id === "aaaa1111" ? "Talks/deck.md" : null),
			store: { readPdfPaths: async (id: string) => (calls.readPdfPaths.push(id), claims[id] ?? null) },
			app: { vault: { getFileByPath: (p: string) => (existing.includes(p) ? { path: p } : null) } },
			inlineInk: { pathForPageId: () => (calls.pathForPageId++, "WRONG") },
		};
		const js = compile(`return { ${wiring()}${NL}};`);
		const lookups = new Function(js.replace(/\bthis\b/g, "self").replace(/^/, "const self = arguments[0];\n"))(self) as {
			pathForNote: (id: string) => string | null;
			pathForPdf: (id: string) => Promise<string | null>;
		};
		return { lookups, calls };
	}
	it("pathForNote asks the startup census, not the open-editor lookup", () => {
		const { lookups, calls } = host();
		expect(lookups.pathForNote("aaaa1111")).toBe("Talks/deck.md");
		expect(calls.notePathFor).toEqual(["aaaa1111"]);
		expect(calls.pathForPageId).toBe(0);
	});
	it("pathForPdf reads the sidecar's claimed paths, and answers null when none", async () => {
		const { lookups, calls } = host();
		expect(await lookups.pathForPdf("bbbb2222")).toBe("Docs/a.pdf");
		expect(await lookups.pathForPdf("cccc3333")).toBeNull();
		expect(calls.readPdfPaths).toEqual(["bbbb2222", "cccc3333"]);
	});
	it("a PDF moved while the app was closed is named by the claimed path that still exists (review S2-1)", async () => {
		const { lookups } = host(["Docs/live.pdf"], { dddd4444: ["Docs/dead.pdf", "Docs/live.pdf"] });
		expect(await lookups.pathForPdf("dddd4444")).toBe("Docs/live.pdf");
	});
	it("when no claimed path exists the last claim names it", async () => {
		const { lookups } = host([], { eeee5555: ["Docs/first.pdf", "Docs/last.pdf"] });
		expect(await lookups.pathForPdf("eeee5555")).toBe("Docs/last.pdf");
	});
});
