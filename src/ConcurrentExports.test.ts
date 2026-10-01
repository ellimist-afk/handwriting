/**
 * TWO EXPORTS AT ONCE MUST NOT EAT EACH OTHER'S OUTPUT.
 *
 * Measured on the published tag and two later refs: two overlapping export
 * callbacks prepared different ink snapshots, chose the SAME free name, and
 * both were told their create succeeded. The second replaced the first, and
 * both notices named the same destination. Nothing was rejected, so a bounded
 * retry could never have caught it.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE HELPER'S OWN TESTS. Those pin the
 * turn directly and would stay green if a caller stopped going through the
 * helper at all. These execute the ACTUAL registered `export-ink-svg` and
 * `export-ink-pdf` callbacks and the ACTUAL `flattenPdf` method, lifted out of
 * `main.ts` source and transpiled, bound to the REAL renderers, the REAL
 * `createFreshFile`, and the real `firstFreePath` loop. Nothing about naming
 * or writing is re-implemented here.
 *
 * THE HOST FIXTURE IS FAITHFUL TO THE OBSERVED CONTRACT, and that is the whole
 * point: `create` awaits an existence check and then awaits an overwrite-capable
 * write. It is NOT an exclusive atomic insertion. A fixture that made create
 * atomic would manufacture a rejection the real host never produces and would
 * prove the opposite of what is being claimed.
 *
 * WHAT THIS DOES NOT COVER: another process, another device, a sync client, or
 * a second copy of the plugin. And the create sites that bypass the helper
 * entirely - `snipNote`, `snipPdf`, `DiagnosticTextModal.saveToVault` - are NOT
 * repaired by this slice and are not exercised here.
 */
import { describe, expect, it } from "vitest";
import { transformSync } from "esbuild";
import { stripMarkdownExtension } from "./util/MarkdownPath";
import mainSource from "./main.ts?raw";
import { createFreshFile } from "./export/CreateFreshFile";
import { inkToSvg } from "./ink/SvgExport";
import { inkToPdf } from "./ink/InkPdf";
import { bytesOf } from "./pdf/PdfSyntax";
import { appendInkToPdf, flattenedPdfPath } from "./ink/InkPdfAppend";
import type { InkStroke } from "./ink/Stroke";

const source = mainSource.replace(/\r\n/g, "\n");

/** A source slice, with both ends proven present and unique. */
function slice(startMarker: string, endMarker: string): string {
	expect(source.split(startMarker), `start marker not unique: ${startMarker}`).toHaveLength(2);
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	expect(end, `end marker missing after: ${startMarker}`).toBeGreaterThan(start);
	return source.slice(start, end + endMarker.length);
}

const SVG_BLOCK = slice('\t\tthis.addCommand({\n\t\t\tid: "export-ink-svg",', "\n\t\t});");
const PDF_BLOCK = slice('\t\tthis.addCommand({\n\t\t\tid: "export-ink-pdf",', "\n\t\t});");
const FLATTEN_BLOCK = slice("\tprivate async flattenPdf(file: TFile, id: string): Promise<void> {", "\n\t}");

// Fail closed if the shapes these tests assume ever move.
expect(SVG_BLOCK).toContain("createFreshFile(");
expect(PDF_BLOCK).toContain("createFreshFile(");
expect(FLATTEN_BLOCK).toContain("createFreshFile(");
expect(SVG_BLOCK.match(/this\.firstFreePath\(/g)).toHaveLength(1);
expect(PDF_BLOCK.match(/this\.firstFreePath\(/g)).toHaveLength(1);
expect(FLATTEN_BLOCK.match(/this\.firstFreePath\(/g)).toHaveLength(1);

const js = (code: string): string => transformSync(code, { loader: "ts", target: "es2022" }).code;

type Deps = Record<string, unknown>;
const build = (code: string, given: Deps): unknown => {
	const deps: Deps = { stripMarkdownExtension, ...given };
	const names = Object.keys(deps);
	return new Function(...names, js(code))(...names.map((n) => deps[n]));
};

/** The two registered commands, as the real `onload` would register them. */
function registerCommand(block: string, deps: Deps, host: PluginStub): CommandSpec {
	// No stub dependencies left: the canvas page view the export blocks used to
	// name went out, and the blocks reference nothing of their own
	// beyond what each caller passes.
	let captured: CommandSpec | null = null;
	const self = { ...host, addCommand: (spec: CommandSpec) => void (captured = spec) };
	(build(`return function () { ${block} }`, deps) as (this: unknown) => void).call(self);
	expect(captured, "the registration did not call addCommand").not.toBeNull();
	return captured!;
}

type CommandSpec = { checkCallback: (checking: boolean) => boolean };
type PluginStub = Record<string, unknown>;

/** A stroke with a distinguishable geometry, so two snapshots cannot be confused. */
const strokeAt = (id: string, x: number): InkStroke => ({
	id,
	color: "#123456",
	width: 2,
	tool: "pen",
	points: [
		{ x, y: x, pressure: 0.5, t: 0 },
		{ x: x + 40, y: x + 25, pressure: 0.5, t: 8 },
		{ x: x + 80, y: x + 5, pressure: 0.5, t: 16 },
	],
	bbox: { x: x - 2, y: x - 2, width: 84, height: 31 },
	createdAt: 1,
});

/** Bytes as an exact latin1 string and back, so a payload can be compared whole. */
const toLatin1 = (bytes: Uint8Array): string => {
	let out = "";
	for (const b of bytes) out += String.fromCharCode(b);
	return out;
};
const fromLatin1 = (s: string): Uint8Array => {
	const a = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
	return a;
};

const SNAPSHOT_A = [strokeAt("a1", 10)];
/** A real, valid source PDF - produced by the plugin's own writer, never hand-typed. */
const REAL_PDF = toLatin1(bytesOf(inkToPdf([strokeAt("seed", 60)])!));
const SNAPSHOT_B = [strokeAt("b1", 300), strokeAt("b2", 420)];

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

const textOf = (v: unknown): string =>
	typeof v === "string" ? v : toLatin1(new Uint8Array(v as ArrayBuffer));

/**
 * An overwrite-capable vault, faithful to the observed host contract: an
 * awaited existence check, then an awaited write that will happily replace.
 */
function makeVault(seed: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(seed));
	const writes: string[] = [];
	let hold: Promise<unknown> | null = null;
	const write = async (path: string, data: unknown): Promise<void> => {
		// exists first...
		await Promise.resolve();
		files.has(path);
		// ...then the write, which is where a held turn is observed.
		if (hold) {
			const h = hold;
			hold = null;
			await h;
		}
		writes.push(path);
		files.set(path, textOf(data));
	};
	return {
		files,
		writes,
		holdNextWrite(p: Promise<unknown>) {
			hold = p;
		},
		vault: {
			adapter: {
				exists: async (path: string) => {
					await Promise.resolve();
					return files.has(path);
				},
			},
			create: write,
			createBinary: write,
			readBinary: async (f: { path: string }) => {
				await Promise.resolve();
				return fromLatin1(files.get(f.path) ?? "").buffer;
			},
		},
	};
}

/**
 * A transparent forwarding wrapper: it records entry into choose and create
 * and then delegates to the ONE real helper, so every caller here still shares
 * a single module-wide queue. It never decides anything.
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
				log.push(`${tag}:create`);
				return create(p);
			},
			attempts
		);
}

/** The real `firstFreePath`, as main.ts defines it, over this fixture's adapter. */
const firstFreePathOn = (vault: { adapter: { exists(p: string): Promise<boolean> } }) =>
	async function (candidate: (n: number) => string): Promise<string> {
		for (let n = 1; ; n++) {
			const path = candidate(n);
			if (!(await vault.adapter.exists(path))) return path;
		}
	};

const notices: string[] = [];
const Notice = class {
	constructor(message: string) {
		notices.push(message);
	}
};
const runDetached = (p: Promise<unknown>, _what: string, onFail?: () => void): void => {
	p.catch(() => onFail?.());
};

type Caller = {
	name: string;
	/** Fire the export for `strokes`, returning when its work is queued. */
	fire(strokes: InkStroke[], tag: string, log: string[]): Promise<void> | void;
	destinations: [string, string];
	existing: Record<string, string>;
	/** The payload each snapshot must end up as, computed independently. */
	expected(strokes: InkStroke[]): string;
};

describe("two overlapping exports keep both snapshots", () => {
	for (const kind of ["svg", "ink-pdf", "flatten"] as const) {
		it(`${kind}: B does not choose while A's write is held, and both snapshots survive`, async () => {
			notices.length = 0;
			const log: string[] = [];
			const seed: Record<string, string> =
				kind === "flatten"
					? { "note.pdf": REAL_PDF, "note.flattened.pdf": "PRE-EXISTING FLATTEN" }
					: { "note.md": "# note", [`note.ink.${kind === "svg" ? "svg" : "pdf"}`]: "PRE-EXISTING EXPORT" };
			const host = makeVault(seed);
			const beforeBytes = new Map(host.files);

			const fire = (strokes: InkStroke[], tag: string): Promise<unknown> => {
				const stub: PluginStub = {
					app: { workspace: { getActiveViewOfType: () => null, getActiveFile: () => ({ path: "note.md", extension: "md" }) }, vault: host.vault },
					firstFreePath: firstFreePathOn(host.vault),
					pdfStore: { strokes: () => strokes },
					// `flattenPdf` reads the pdf ink colour mode off the plugin,
					// so the lifted block needs one here or it throws before it
					// reaches the helper this test is watching. The value is the
					// shipped default; nothing in this file is about colour,
					// only about which writes happen.
					settings: { inkPdfColorMode: "darken" },
				};
				const deps: Deps = {
					inlineInk: { hasInk: () => true, strokes: () => strokes },
					inkToSvg,
					inkToPdf,
					bytesOf,
					appendInkToPdf,
					flattenedPdfPath,
					Notice,
					runDetached,
					createFreshFile: watchedHelper(tag, log),
				};
				if (kind === "flatten") {
					const Holder = build(`return class { ${FLATTEN_BLOCK} }`, deps) as {
						prototype: { flattenPdf(this: unknown, f: unknown, id: string): Promise<void> };
					};
					return Holder.prototype.flattenPdf.call(stub, { path: "note.pdf" }, "id");
				}
				const spec = registerCommand(kind === "svg" ? SVG_BLOCK : PDF_BLOCK, deps, stub);
				spec.checkCallback(false);
				return Promise.resolve();
			};

			const held = deferred<void>();
			host.holdNextWrite(held.promise);

			const a = fire(SNAPSHOT_A, "A");
			a.catch(() => {});
			await settleMicrotasks();
			expect(log.filter((l) => l.startsWith("A:")).length, "A never entered the helper").toBeGreaterThan(0);

			const b = fire(SNAPSHOT_B, "B");
			b.catch(() => {});
			try {
				await settleMicrotasks();
				// THE DEFECT: B choosing here means it was handed the name A is
				// about to occupy, and the overwrite-capable write lets both win.
				expect(
					log.filter((l) => l.startsWith("B:")),
					`B entered the helper while A's write was held: ${JSON.stringify(log)}`
				).toEqual([]);
			} finally {
				// Released unconditionally, never as a reward for B behaving.
				held.resolve();
			}

			await Promise.all([a, b]);
			await settleMicrotasks();

			// Two distinct destinations, and neither is the pre-existing file.
			expect(new Set(host.writes).size, `both exports wrote to: ${JSON.stringify(host.writes)}`).toBe(2);
			for (const [path, bytes] of beforeBytes) {
				expect(host.files.get(path), `pre-existing ${path} was overwritten`).toBe(bytes);
			}
		});
	}

	it("serial control: two exports one after the other already keep both, and still do", async () => {
		notices.length = 0;
		const log: string[] = [];
		const host = makeVault({ "note.md": "# note" });
		const fire = (strokes: InkStroke[], tag: string) => {
			const stub: PluginStub = {
				app: { workspace: { getActiveViewOfType: () => null, getActiveFile: () => ({ path: "note.md", extension: "md" }) }, vault: host.vault },
				firstFreePath: firstFreePathOn(host.vault),
			};
			const spec = registerCommand(SVG_BLOCK, {
				inlineInk: { hasInk: () => true, strokes: () => strokes },
				inkToSvg,
				Notice,
				runDetached,
				createFreshFile: watchedHelper(tag, log),
			}, stub);
			spec.checkCallback(false);
		};
		fire(SNAPSHOT_A, "A");
		await settleMicrotasks();
		fire(SNAPSHOT_B, "B");
		await settleMicrotasks();
		expect(new Set(host.writes).size).toBe(2);
		expect(host.writes).toEqual(["note.ink.svg", "note.ink-2.svg"]);
	});

	it("checking=true mutates nothing", async () => {
		const host = makeVault({ "note.md": "# note" });
		const stub: PluginStub = {
			app: { workspace: { getActiveViewOfType: () => null, getActiveFile: () => ({ path: "note.md", extension: "md" }) }, vault: host.vault },
			firstFreePath: firstFreePathOn(host.vault),
		};
		const spec = registerCommand(SVG_BLOCK, {
			inlineInk: { hasInk: () => true, strokes: () => SNAPSHOT_A },
			inkToSvg,
			Notice,
			runDetached,
			createFreshFile: watchedHelper("probe", []),
		}, stub);
		expect(spec.checkCallback(true)).toBe(true);
		await settleMicrotasks();
		expect(host.writes).toEqual([]);
	});
});
