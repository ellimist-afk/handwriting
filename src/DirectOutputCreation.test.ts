/**
 * THE THREE CREATE SITES THAT STILL BYPASS THE TURN.
 *
 * `concurrent-export-preservation` (14d772f) corrected `createFreshFile` so
 * that choosing a name and creating it happen inside one turn. That fixed the
 * callers which already went through the helper. It could not reach the three
 * that never did: `snipNote`, `snipPdf` and `DiagnosticTextModal.saveToVault`
 * each ran `firstFreePath` (or their own scan) and then wrote, so two
 * overlapping snips still chose the same `.snip-N.png`, wrote different bytes,
 * and BOTH reported success. The predecessor test file says exactly that in
 * its own header: those sites "are NOT repaired by this slice and are not
 * exercised here". This file exercises them.
 *
 * WHAT IS REAL HERE. The `snipNote`, `snipPdf` and `firstFreePath` bodies are
 * lifted out of `main.ts` source and transpiled, so the code under test is the
 * shipped code rather than a restatement of it; the modal method is imported.
 * The helper is the REAL `createFreshFile` - reached through a transparent
 * wrapper that only records entry - so every caller in this file shares the one
 * module-wide queue, which is the entire claim. Nothing about naming, writing
 * or notices is re-implemented here.
 *
 * THE HOST FIXTURE IS DELIBERATELY NOT ATOMIC. It awaits an existence check and
 * then awaits an overwrite-capable write, which is what Obsidian was measured
 * doing. Making create an exclusive insertion would manufacture a rejection the
 * real host never produces and would prove the opposite of what is claimed
 * here: nothing was ever rejected, which is why a bounded retry could not have
 * caught this.
 *
 * WHAT THIS DOES NOT COVER: another process, another device, a sync client, a
 * second copy of the plugin, or a real mobile clipboard. The guarantee is
 * between in-process callers sharing this module instance. Queue waiting can
 * affect user activation on hardware, and no synthetic control here shows that
 * an iPad clipboard write survives it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			constructor(message: string) {
				notices.messages.push(message);
			}
		},
	};
});

import { transformSync } from "esbuild";
import { Notice, normalizePath } from "obsidian";
import mainSource from "./main.ts?raw";
import { createFreshFile } from "./export/CreateFreshFile";
import { DiagnosticTextModal } from "./diag/DiagnosticTextModal";
import { stripMarkdownExtension } from "./util/MarkdownPath";

const source = mainSource.replace(/\r\n/g, "\n");

/** A source slice, with both ends proven present and unique. */
function slice(startMarker: string, endMarker: string): string {
	expect(source.split(startMarker), `start marker not unique: ${startMarker}`).toHaveLength(2);
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	expect(end, `end marker missing after: ${startMarker}`).toBeGreaterThan(start);
	return source.slice(start, end + endMarker.length);
}

const FIRST_FREE_PATH_BLOCK = slice(
	"\tprivate async firstFreePath(candidate: (n: number) => string): Promise<string> {",
	"\n\t}"
);
const SNIP_NOTE_BLOCK = slice(
	"\tprivate async snipNote(file: TFile, overlay: InkOverlayPlugin): Promise<void> {",
	"\n\t}"
);
const SNIP_BACKLINK_BLOCK = slice(
	"\tprivate snipBacklink(file: TFile, subpath?: string, alias?: string): string {",
	"\n\t}"
);
const SNIP_PDF_BLOCK = slice(
	"\tprivate async snipPdf(file: TFile, controller: PdfInkController): Promise<void> {",
	"\n\t}"
);

// Fail closed if the shapes these tests assume ever move. The counted name and
// the clipboard-before-write order are the two things this slice must not change.
expect(FIRST_FREE_PATH_BLOCK).toContain("adapter.exists");
expect(SNIP_NOTE_BLOCK).toContain(".snip-${n}.png");
expect(SNIP_PDF_BLOCK).toContain(".snip-${n}.png");
expect(SNIP_NOTE_BLOCK).toContain("clipboard.writeText");
expect(SNIP_PDF_BLOCK).toContain("clipboard.writeText");
expect(SNIP_BACKLINK_BLOCK).toContain("generateMarkdownLink");

const js = (code: string): string => transformSync(code, { loader: "ts", target: "es2022" }).code;

type Deps = Record<string, unknown>;
const build = (code: string, deps: Deps): unknown => {
	const names = Object.keys(deps);
	return new Function(...names, js(code))(...names.map((n) => deps[n]));
};

type SnipHost = {
	firstFreePath(candidate: (n: number) => string): Promise<string>;
	snipNote(file: unknown, overlay: unknown): Promise<void>;
	snipPdf(file: unknown, controller: unknown): Promise<void>;
};

/** The three real method bodies on one prototype, so `this.firstFreePath` is the real loop. */
const holderFor = (deps: Deps): { prototype: SnipHost } =>
	build(`return class { ${FIRST_FREE_PATH_BLOCK}\n${SNIP_BACKLINK_BLOCK}\n${SNIP_NOTE_BLOCK}\n${SNIP_PDF_BLOCK} }`, { stripMarkdownExtension, ...deps }) as {
		prototype: SnipHost;
	};

/** Bytes as an exact latin1 string and back, so a payload can be compared whole. */
const toLatin1 = (bytes: Uint8Array): string => {
	let out = "";
	for (const b of bytes) out += String.fromCharCode(b);
	return out;
};
const textOf = (v: unknown): string =>
	typeof v === "string" ? v : toLatin1(new Uint8Array(v as ArrayBuffer));

/** Distinct, independently known payloads. Neither is read back from a destination. */
const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0x01]);
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xbb, 0x02]);
const PAYLOAD_A = toLatin1(PNG_A);
const PAYLOAD_B = toLatin1(PNG_B);
const REPORT_A = "REPORT A - the first diagnostic snapshot";
const REPORT_B = "REPORT B - a different diagnostic snapshot";

const deferred = <T,>() => {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	promise.catch(() => {});
	return { promise, resolve, reject };
};

const settleMicrotasks = async (rounds = 30): Promise<void> => {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
};

/**
 * An overwrite-capable vault, faithful to the observed host contract: an
 * awaited existence check, then an awaited write that will happily replace.
 * Every view is tagged, so which caller reached a name scan or a create is
 * recorded from the HOST side too - the unrouted baseline never enters the
 * helper at all, and a test that waited for its helper admission would wait
 * forever and prove nothing.
 */
function makeHost(seed: Record<string, string> = {}, folders: string[] = []) {
	const files = new Map<string, string>(Object.entries(seed));
	const dirs = new Set<string>(folders);
	const writes: string[] = [];
	const createEntries: string[] = [];
	const holds = new Map<string, Promise<unknown>>();
	const failures = new Map<string, string>();

	const view = (tag: string, log: string[], opts: { existsThrows?: boolean } = {}) => {
		const write = async (path: string, data: unknown): Promise<{ path: string }> => {
			log.push(`${tag}:create`);
			createEntries.push(`${tag}:${path}`);
			// exists first...
			await Promise.resolve();
			files.has(path);
			// ...then the write, which is where a held turn is observed.
			const held = holds.get(tag);
			if (held) {
				holds.delete(tag);
				await held;
			}
			const failure = failures.get(tag);
			if (failure) throw new Error(failure);
			writes.push(path);
			files.set(path, textOf(data));
			return { path };
		};
		return {
			adapter: {
				exists: async (path: string): Promise<boolean> => {
					log.push(`${tag}:exists`);
					await Promise.resolve();
					if (opts.existsThrows) throw new Error("the vault could not be read");
					return files.has(path) || dirs.has(path);
				},
			},
			create: write,
			createBinary: write,
			getAbstractFileByPath: (path: string): unknown => {
				log.push(`${tag}:scan`);
				if (files.has(path)) return { path };
				if (dirs.has(path)) return { path, children: [] };
				return null;
			},
		};
	};

	return {
		files,
		writes,
		createEntries,
		view,
		holdFor(tag: string, p: Promise<unknown>) {
			holds.set(tag, p);
		},
		failFor(tag: string, message: string) {
			failures.set(tag, message);
		},
	};
}

/**
 * A transparent forwarding wrapper: it records entry into choose and create and
 * then delegates to the ONE real helper, so every caller here still shares a
 * single module-wide queue. It never decides anything, and nothing in these
 * tests is unlocked by it.
 */
function watchedHelper(tag: string, log: string[]) {
	return <T,>(
		choose: () => Promise<string>,
		create: (path: string) => Promise<T>,
		attempts?: number
	): Promise<{ path: string; result: T }> =>
		createFreshFile(
			async () => {
				log.push(`${tag}:choose`);
				return choose();
			},
			async (p) => {
				log.push(`${tag}:callback`);
				return create(p);
			},
			attempts
		);
}

type SnipOpts = {
	tag: string;
	log: string[];
	host: ReturnType<typeof makeHost>;
	bytes: Uint8Array;
	refuseClipboard?: boolean;
	ambiguous?: boolean;
	/** Paths of OTHER files in the vault, so the model link generator can qualify a duplicate name. */
	siblings?: string[];
	/** Every generateMarkdownLink call: the file it was asked for, and the rest of the arguments. */
	linkCalls?: { file: unknown; args: unknown[] }[];
	/** When set, the model generator returns this instead of its own link, to see it written verbatim. */
	linkReturns?: string;
	existsThrows?: boolean;
	clips?: string[];
};

const errors: string[] = [];
const quietConsole = {
	error: (...args: unknown[]) => void errors.push(args.map(String).join(" ")),
	warn: () => {},
	log: () => {},
};

function snipDeps(o: SnipOpts): Deps {
	return {
		Notice,
		normalizePath,
		console: quietConsole,
		createFreshFile: watchedHelper(o.tag, o.log),
		navigator: {
			clipboard: {
				writeText: async (md: string): Promise<void> => {
					o.log.push(`${o.tag}:clip`);
					o.clips?.push(md);
					await Promise.resolve();
					if (o.refuseClipboard) throw new Error("the clipboard refused");
				},
			},
		},
	};
}

function snipInstance(o: SnipOpts): SnipHost {
	const inst = Object.create(holderFor(snipDeps(o)).prototype) as SnipHost;
	(inst as unknown as { app: unknown }).app = {
		vault: o.host.view(o.tag, o.log, { existsThrows: o.existsThrows }),
		metadataCache: {
			getFirstLinkpathDest: (name: string) => (o.ambiguous ? { path: `elsewhere/${name}` } : null),
		},
		fileManager: {
			// Models Obsidian's own generator for the one behaviour these cells
			// need: the shortest name that is unambiguous, the path when it is
			// not, no .md on a note, the subpath and alias appended.
			generateMarkdownLink: (file: { path: string; name: string }, ...args: unknown[]): string => {
				o.linkCalls?.push({ file, args });
				if (o.linkReturns !== undefined) return o.linkReturns;
				const [, subpath = "", alias] = args as [string, string | undefined, string | undefined];
				const isNote = file.path.endsWith(".md");
				const bare = isNote ? file.name.replace(/\.md$/, "") : file.name;
				const full = isNote ? file.path.replace(/\.md$/, "") : file.path;
				const dup = (o.siblings ?? []).some((s) => s.split("/").pop() === file.name && s !== file.path);
				return `[[${dup ? full : bare}${subpath}${alias ? `|${alias}` : ""}]]`;
			},
		},
	};
	return inst;
}

const NOTE_FILE = { path: "folderA/source.md", basename: "source", name: "source.md" };
const PDF_FILE = { path: "folderA/paper.pdf", basename: "paper", name: "paper.pdf" };

const fireSnipNote = (o: SnipOpts): Promise<void> =>
	snipInstance(o).snipNote(NOTE_FILE, { snipSelection: async () => ({ ok: true, bytes: o.bytes }) });

const fireSnipPdf = (o: SnipOpts, pageNumber = 7): Promise<void> =>
	snipInstance(o).snipPdf(PDF_FILE, {
		snipSelection: async () => ({ ok: true, bytes: o.bytes, pageNumber }),
	});

/** The diagnostic modal, with the stub `Modal` given the app it never sets. */
function makeModal(
	host: ReturnType<typeof makeHost>,
	tag: string,
	log: string[],
	text: string,
	onDelivered?: () => void
): { save(): Promise<void>; setText(v: string): void } {
	const modal = new DiagnosticTextModal({} as never, "heading", text, undefined, onDelivered) as unknown as {
		app: unknown;
		text: string;
		saveToVault(): Promise<void>;
	};
	modal.app = { vault: host.view(tag, log) };
	return {
		save: () => modal.saveToVault(),
		setText: (v: string) => void (modal.text = v),
	};
}

/** The fixed second both diagnostic saves land in - the collision the receipt describes. */
const FIXED_STAMP = "20260908-024405";
const DIAG_BASE = `handwriting-diagnostics-${FIXED_STAMP}`;
const freezeClock = (): void => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 8, 8, 2, 44, 5));
};

afterEach(() => {
	vi.useRealTimers();
	notices.messages.length = 0;
	errors.length = 0;
});

describe("two overlapping outputs keep both snapshots", () => {
	for (const kind of ["note", "pdf"] as const) {
		it(`${kind}: B cannot choose or create while A is held, and both snips survive`, async () => {
			const log: string[] = [];
			const host = makeHost({
				"folderA/source.md": "# source",
				"folderA/paper.pdf": "%PDF-1.7 original",
				"folderA/source.snip-1.png": "PRE-EXISTING ATTACHMENT",
				"folderA/paper.snip-1.png": "PRE-EXISTING ATTACHMENT",
			});
			const before = new Map(host.files);
			const fire = kind === "note" ? fireSnipNote : fireSnipPdf;
			const stem = kind === "note" ? "folderA/source" : "folderA/paper";

			const held = deferred<void>();
			host.holdFor("A", held.promise);

			const a = fire({ tag: "A", log, host, bytes: PNG_A });
			a.catch(() => {});
			await settleMicrotasks();
			expect(log.filter((l) => l.startsWith("A:")).length, "A never reached the host at all").toBeGreaterThan(
				0
			);

			const b = fire({ tag: "B", log, host, bytes: PNG_B });
			b.catch(() => {});
			try {
				// THE DEFECT: B looking for a name here means it is handed the one A
				// is about to occupy, and the overwrite-capable write lets both think
				// they won. Recorded from the host side as well as the helper side,
				// because the unrouted baseline never enters the helper.
				await settleMicrotasks();
				expect(
					log.filter((l) => l.startsWith("B:")),
					`B chose or created while A was held: ${JSON.stringify(log)}`
				).toEqual([]);
			} finally {
				// Released unconditionally, never as a reward for B behaving.
				held.resolve();
			}

			await Promise.all([a, b]);
			await settleMicrotasks();

			expect(new Set(host.writes).size, `both snips wrote to: ${JSON.stringify(host.writes)}`).toBe(2);
			expect(new Set(host.writes)).toEqual(new Set([`${stem}.snip-2.png`, `${stem}.snip-3.png`]));
			expect(new Set([host.files.get(`${stem}.snip-2.png`), host.files.get(`${stem}.snip-3.png`)])).toEqual(
				new Set([PAYLOAD_A, PAYLOAD_B])
			);
			for (const [path, bytes] of before) {
				expect(host.files.get(path), `pre-existing ${path} was overwritten`).toBe(bytes);
			}
			// Each notice names the path that call actually got, not one predicted early.
			const stemName = stem.split("/").pop();
			const named = notices.messages.map((m) => m.replace("Handwriting: snipped to ", "").split(";")[0]);
			expect(new Set(named)).toEqual(new Set([`${stemName}.snip-2.png`, `${stemName}.snip-3.png`]));
		});
	}

	it("diagnostic: a second report in the same second cannot take the first one name", async () => {
		freezeClock();
		const log: string[] = [];
		const host = makeHost({ "existing.md": "keep me" });
		const before = new Map(host.files);

		const held = deferred<void>();
		host.holdFor("A", held.promise);

		const a = makeModal(host, "A", log, REPORT_A).save();
		a.catch(() => {});
		await settleMicrotasks();
		expect(log.filter((l) => l.startsWith("A:")).length, "A never reached the host").toBeGreaterThan(0);

		const b = makeModal(host, "B", log, REPORT_B).save();
		b.catch(() => {});
		try {
			await settleMicrotasks();
			expect(
				log.filter((l) => l.startsWith("B:")),
				`B scanned or created while A was held: ${JSON.stringify(log)}`
			).toEqual([]);
		} finally {
			held.resolve();
		}

		await Promise.all([a, b]);
		await settleMicrotasks();

		expect(new Set(host.writes).size, `both reports wrote to: ${JSON.stringify(host.writes)}`).toBe(2);
		expect(new Set(host.writes)).toEqual(new Set([`${DIAG_BASE}.md`, `${DIAG_BASE}-2.md`]));
		expect(new Set([host.files.get(`${DIAG_BASE}.md`), host.files.get(`${DIAG_BASE}-2.md`)])).toEqual(
			new Set([REPORT_A, REPORT_B])
		);
		for (const [path, bytes] of before) {
			expect(host.files.get(path), `pre-existing ${path} was overwritten`).toBe(bytes);
		}
	});

	it("a snip and a diagnostic share ONE queue, not two that each pass alone", async () => {
		freezeClock();
		const log: string[] = [];
		const host = makeHost({ "folderA/source.md": "# source" });

		const held = deferred<void>();
		host.holdFor("A", held.promise);

		const a = fireSnipNote({ tag: "A", log, host, bytes: PNG_A });
		a.catch(() => {});
		await settleMicrotasks();
		expect(log.filter((l) => l.startsWith("A:")).length).toBeGreaterThan(0);

		const b = makeModal(host, "B", log, REPORT_A).save();
		b.catch(() => {});
		try {
			await settleMicrotasks();
			expect(
				log.filter((l) => l.startsWith("B:")),
				`the diagnostic ran while a snip held the turn: ${JSON.stringify(log)}`
			).toEqual([]);
		} finally {
			held.resolve();
		}

		await Promise.all([a, b]);
		await settleMicrotasks();
		expect(host.writes).toEqual(["folderA/source.snip-1.png", `${DIAG_BASE}.md`]);
	});
});

describe("serial controls: what already worked keeps working", () => {
	it("two snips one after the other count up and keep both", async () => {
		const log: string[] = [];
		const host = makeHost({ "folderA/source.md": "# source" });
		await fireSnipNote({ tag: "A", log, host, bytes: PNG_A });
		await fireSnipNote({ tag: "B", log, host, bytes: PNG_B });
		expect(host.writes).toEqual(["folderA/source.snip-1.png", "folderA/source.snip-2.png"]);
		expect(host.files.get("folderA/source.snip-1.png")).toBe(PAYLOAD_A);
		expect(host.files.get("folderA/source.snip-2.png")).toBe(PAYLOAD_B);
	});

	it("the embed is the bare name, and the full path exactly when the name is ambiguous", async () => {
		const host = makeHost({ "folderA/source.md": "# source" });
		const plain: string[] = [];
		await fireSnipNote({ tag: "A", log: [], host, bytes: PNG_A, clips: plain });
		expect(plain[0]).toBe("![[source.snip-1.png]]\n[[source]]");

		const ambiguous: string[] = [];
		await fireSnipNote({ tag: "B", log: [], host, bytes: PNG_B, clips: ambiguous, ambiguous: true });
		expect(ambiguous[0]).toBe("![[folderA/source.snip-2.png]]\n[[source]]");
	});

	it("the backlink names the inked file, not the other file of the same name (#181)", async () => {
		const clips: string[] = [];
		await fireSnipNote({
			tag: "A",
			log: [],
			host: makeHost({ "folderA/source.md": "# a" }),
			bytes: PNG_A,
			clips,
			siblings: ["folderB/source.md"],
		});
		expect(clips[0]).toBe("![[source.snip-1.png]]\n[[folderA/source]]");

		const pdfClips: string[] = [];
		await fireSnipPdf(
			{
				tag: "B",
				log: [],
				host: makeHost({ "folderA/paper.pdf": "%PDF" }),
				bytes: PNG_A,
				clips: pdfClips,
				siblings: ["folderB/paper.pdf"],
			},
			3
		);
		expect(pdfClips[0]).toBe("![[paper.snip-1.png]]\n[[folderA/paper.pdf#page=3|paper p.3]]");
	});

	it("both backlinks are what Obsidian's generator returns, asked for the inked file, subpath and alias", async () => {
		const linkCalls: { file: unknown; args: unknown[] }[] = [];
		const clips: string[] = [];
		const host = makeHost({ "folderA/source.md": "# x", "folderA/paper.pdf": "%PDF" });
		const inst = (tag: string) =>
			snipInstance({ tag, log: [], host, bytes: PNG_A, clips, linkCalls, linkReturns: "<<GENERATED>>" });
		await inst("A").snipNote(NOTE_FILE, { snipSelection: async () => ({ ok: true, bytes: PNG_A }) });
		await inst("B").snipPdf(PDF_FILE, { snipSelection: async () => ({ ok: true, bytes: PNG_B, pageNumber: 5 }) });
		expect(linkCalls).toEqual([
			{ file: NOTE_FILE, args: ["", undefined, undefined] },
			{ file: PDF_FILE, args: ["", "#page=5", "paper p.5"] },
		]);
		expect(clips.map((c) => c.split("\n")[1])).toEqual(["<<GENERATED>>", "<<GENERATED>>"]);
	});

	it("the pdf embed keeps its page number and its own destination", async () => {
		const host = makeHost({ "folderA/paper.pdf": "%PDF" });
		const clips: string[] = [];
		await fireSnipPdf({ tag: "A", log: [], host, bytes: PNG_A, clips }, 12);
		expect(clips[0]).toBe("![[paper.snip-1.png]]\n[[paper.pdf#page=12|paper p.12]]");
	});

	it("a folder occupying the report name counts as occupied", async () => {
		freezeClock();
		const host = makeHost({}, [`${DIAG_BASE}.md`]);
		await makeModal(host, "A", [], REPORT_A).save();
		expect(host.writes).toEqual([`${DIAG_BASE}-2.md`]);
		expect(host.files.get(`${DIAG_BASE}-2.md`)).toBe(REPORT_A);
	});

	it("the report queued behind another keeps the text it was invoked with", async () => {
		freezeClock();
		const log: string[] = [];
		const host = makeHost();
		const held = deferred<void>();
		host.holdFor("A", held.promise);

		const a = makeModal(host, "A", log, REPORT_A).save();
		a.catch(() => {});
		await settleMicrotasks();

		const second = makeModal(host, "B", log, REPORT_B);
		const b = second.save();
		b.catch(() => {});
		await settleMicrotasks();
		// The report is edited after its save began. The file must still be the
		// snapshot the reader asked to save.
		second.setText("MUTATED AFTER THE SAVE BEGAN");
		held.resolve();

		await Promise.all([a, b]);
		await settleMicrotasks();
		expect(host.files.get(`${DIAG_BASE}-2.md`)).toBe(REPORT_B);
	});
});

describe("a failed create is reported honestly and does not block the next caller", () => {
	it("snip: the create for A rejects once, B still keeps its own output", async () => {
		const log: string[] = [];
		const host = makeHost({ "folderA/source.md": "# source" });
		host.failFor("A", "the disk is full");

		const a = fireSnipNote({ tag: "A", log, host, bytes: PNG_A });
		const b = fireSnipNote({ tag: "B", log, host, bytes: PNG_B });
		await Promise.all([a, b]);
		await settleMicrotasks();

		// One create attempt, not eight: this slice must not add retry semantics
		// with clipboard side effects to callers that only ever tried once.
		expect(host.createEntries.filter((e) => e.startsWith("A:"))).toHaveLength(1);
		expect(log.filter((l) => l === "A:clip")).toHaveLength(1);
		expect(notices.messages).toContain(
			"Handwriting: the snip could not be written; the embed on your clipboard has nowhere to point"
		);
		// Exactly one success and one failure. The name cannot separate them - A
		// failed at `snip-1.png` without occupying it, so B is entitled to it and
		// says so - but the counts can, and a second success would be the lie.
		expect(notices.messages.filter((m) => m.startsWith("Handwriting: snipped to "))).toHaveLength(1);
		expect(
			notices.messages.filter((m) => m.startsWith("Handwriting: the snip could not be written"))
		).toHaveLength(1);
		expect(host.writes).toEqual(["folderA/source.snip-1.png"]);
		expect(host.files.get("folderA/source.snip-1.png")).toBe(PAYLOAD_B);
	});

	it("snip: a rejected chooser claims no embed was copied, because none was", async () => {
		const log: string[] = [];
		const host = makeHost({ "folderA/source.md": "# source" });
		await expect(
			fireSnipNote({ tag: "A", log, host, bytes: PNG_A, existsThrows: true })
		).resolves.toBeUndefined();
		expect(log).not.toContain("A:clip");
		expect(notices.messages).toEqual(["Handwriting: the snip could not be written"]);
		expect(host.writes).toEqual([]);
	});

	it("diagnostic: a rejected create reports the failure, delivers nothing, and frees the turn", async () => {
		freezeClock();
		const log: string[] = [];
		const host = makeHost();
		host.failFor("A", "read only vault");
		let deliveredA = 0;
		let deliveredB = 0;

		const a = makeModal(host, "A", log, REPORT_A, () => void deliveredA++).save();
		const b = makeModal(host, "B", log, REPORT_B, () => void deliveredB++).save();
		await Promise.all([a, b]);
		await settleMicrotasks();

		expect(host.createEntries.filter((e) => e.startsWith("A:"))).toHaveLength(1);
		expect(deliveredA).toBe(0);
		expect(deliveredB).toBe(1);
		expect(notices.messages.some((m) => m.startsWith("Handwriting: could not save the report:"))).toBe(true);
		expect(host.writes).toEqual([`${DIAG_BASE}.md`]);
		expect(host.files.get(`${DIAG_BASE}.md`)).toBe(REPORT_B);
	});
});

describe("the clipboard matrix: the copy is attempted before the write, and each notice is true", () => {
	it("copy succeeds, create succeeds", async () => {
		const log: string[] = [];
		const host = makeHost({ "folderA/source.md": "# source" });
		await fireSnipNote({ tag: "A", log, host, bytes: PNG_A });
		expect(log.indexOf("A:clip")).toBeLessThan(log.indexOf("A:create"));
		expect(notices.messages).toEqual([
			"Handwriting: snipped to source.snip-1.png; the embed is on your clipboard",
		]);
	});

	it("copy refuses, the file is still written", async () => {
		const log: string[] = [];
		const host = makeHost({ "folderA/source.md": "# source" });
		await fireSnipNote({ tag: "A", log, host, bytes: PNG_A, refuseClipboard: true });
		expect(log.indexOf("A:clip")).toBeLessThan(log.indexOf("A:create"));
		expect(host.files.get("folderA/source.snip-1.png")).toBe(PAYLOAD_A);
		expect(notices.messages).toEqual([
			"Handwriting: snipped to source.snip-1.png; the clipboard refused the embed",
		]);
	});

	it("copy succeeds, create rejects: the embed has nowhere to point and the notice says so", async () => {
		const log: string[] = [];
		const host = makeHost({ "folderA/source.md": "# source" });
		host.failFor("A", "no space");
		await fireSnipNote({ tag: "A", log, host, bytes: PNG_A });
		expect(notices.messages).toEqual([
			"Handwriting: the snip could not be written; the embed on your clipboard has nowhere to point",
		]);
	});

	it("both refuse: one plain failure, and no claim about the clipboard", async () => {
		const log: string[] = [];
		const host = makeHost({ "folderA/source.md": "# source" });
		host.failFor("A", "no space");
		await fireSnipNote({ tag: "A", log, host, bytes: PNG_A, refuseClipboard: true });
		expect(notices.messages).toEqual(["Handwriting: the snip could not be written"]);
	});

	it("every recorded embed points at the path its own call created", async () => {
		const log: string[] = [];
		const host = makeHost({ "folderA/source.md": "# source" });
		const clipsA: string[] = [];
		const clipsB: string[] = [];
		const held = deferred<void>();
		host.holdFor("A", held.promise);
		const a = fireSnipNote({ tag: "A", log, host, bytes: PNG_A, clips: clipsA });
		a.catch(() => {});
		await settleMicrotasks();
		const b = fireSnipNote({ tag: "B", log, host, bytes: PNG_B, clips: clipsB });
		b.catch(() => {});
		held.resolve();
		await Promise.all([a, b]);
		await settleMicrotasks();
		expect(clipsA[0]).toContain("source.snip-1.png");
		expect(clipsB[0]).toContain("source.snip-2.png");
		expect(host.files.get("folderA/source.snip-1.png")).toBe(PAYLOAD_A);
		expect(host.files.get("folderA/source.snip-2.png")).toBe(PAYLOAD_B);
	});
});
