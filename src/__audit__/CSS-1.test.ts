/**
 * AUDIT PROBE CSS-1 (read-only audit of 1.4.21, tag 1a05f62c).
 *
 * Claim: the status bar is hidden while body has `handwriting-active-page`
 * (styles.css:2355). main.ts keys that class to inlineInk.isHandwritingPage,
 * which is true whenever the note's frontmatter holds a handwriting-page-id.
 * The first stroke writes that id and nothing removes it, so after "Delete
 * all ink" (and after a restart) a note with zero ink still hides the status
 * bar for good.
 *
 * Production code driven:
 *  - the REAL InlineInkStore (commitGesture -> persist -> claim, deleteAll
 *    readiness/capture, applyRemove = what InkOverlay.clearAllInk calls,
 *    ensureLoaded after a restart, isHandwritingPage);
 *  - main.ts's notePageId (the host readPageId, main.ts:2034) and
 *    claimNotePageId (the host claimId, main.ts:2035), sliced verbatim and
 *    transpiled, over a fake vault/metadata cache;
 *  - main.ts's updateStatusBarClass, sliced verbatim;
 *  - styles.css parsed with postcss: every rule that targets `.status-bar`.
 *
 * Assertions state the CORRECT behaviour: green = no bug, red = bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformSync } from "esbuild";
import postcss from "postcss";
import mainSource from "../main.ts?raw";
import inkOverlaySource from "../inline/InkOverlay.ts?raw";
import stylesSource from "../../styles.css?raw";
import { InlineInkStore, type InlineInkHost } from "../inline/InlineInkStore";
import { UnreadableFrontmatterError, claimMarkdown, hasFrontmatterBlock } from "../inline/InlineClaim";
import { parseMarkdownPage } from "../model/MarkdownPage";
import { isSafePageId, type PageData, type ParseResult } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const source = mainSource.replace(/\r\n/g, "\n");
const overlay = inkOverlaySource.replace(/\r\n/g, "\n");

function between(startMarker: string, endMarker: string): string {
	expect(source.split(startMarker)).toHaveLength(2);
	const s = source.indexOf(startMarker) + startMarker.length;
	const e = source.indexOf(endMarker, s);
	expect(e).toBeGreaterThan(s);
	return source.slice(s, e);
}

// ---- slice production code out of main.ts -----------------------------------

// Since 1.4.22 the closure calls the plugin method `applyStatusBarVisibility`, which reads the setting (default off)
// and keys the class on strokes. The method body is sliced verbatim and run with the plugin as `this`.
const methodStart = "\tapplyStatusBarVisibility(): void {\n";
expect(source.split(methodStart)).toHaveLength(2);
const ms = source.indexOf(methodStart) + methodStart.length;
const methodBody = source.slice(ms, source.indexOf("\n\t}\n", ms));
expect(methodBody).toContain('"handwriting-active-page"');
expect(methodBody).toContain("inlineInk.inkPresence(path)");
expect(source).toContain("const updateStatusBarClass = (): void => this.applyStatusBarVisibility();");
const methodCode = transformSync(
	`const self = this;\nself.settings = self.settings ?? { hideStatusBarOnInkedNotes: false };\nself.unloaded = self.unloaded ?? false;\nself.applyStatusBarVisibility = function () {\n${methodBody}\n};\nreturn () => self.applyStatusBarVisibility();`,
	{ loader: "ts", target: "es2022" }
).code;
const makeUpdateStatusBarClass = new Function("inlineInk", "document", methodCode);

// notePageId (main.ts:4999-5019), verbatim body.
const notePageIdBody = between(
	"\tprivate notePageId(path: string): string | null {\n",
	"\n\t}\n\n\t/**\n\t * Atomically stamp"
);
expect(notePageIdBody).toContain('fm?.["handwriting-page-id"]');
const makeNotePageId = new Function(
	"isSafePageId",
	transformSync(`return function notePageId(path: string): string | null {\n${notePageIdBody}\n};`, {
		loader: "ts",
		target: "es2022",
	}).code
);

// claimNotePageId (main.ts:5021-5044), verbatim body.
expect(source).toContain("\tprivate async claimNotePageId(\n");
const claimBody = between(
	"): Promise<{ pageId: string; futureVersion?: number; content?: string }> {\n",
	"\n\t}\n\n\t/**\n\t * Start slides ink"
);
expect(claimBody).toContain("const r = claimMarkdown(data, proposedId);");
// The body refuses a frontmatter block Obsidian cannot parse; both names are main.ts imports from InlineClaim.
expect(claimBody).toContain("hasFrontmatterBlock(data)");
expect(claimBody).toContain("throw new UnreadableFrontmatterError();");
const makeClaimNotePageId = new Function(
	"claimMarkdown",
	"hasFrontmatterBlock",
	"UnreadableFrontmatterError",
	transformSync(
		`return async function claimNotePageId(path: string, proposedId: string, guard?: any): Promise<any> {\n${claimBody}\n};`,
		{ loader: "ts", target: "es2022" }
	).code
);

// Host wiring precondition: the inline store's host reads/claims through these two.
expect(source).toContain("readPageId: (path) => this.notePageId(path),");
expect(source).toContain("claimId: (path, proposedId) => this.claimNotePageId(path, proposedId),");

// Delete-all precondition: the wipe the command reaches is InkOverlay.clearAllInk,
// whose only store mutation is inlineInk.applyRemove(path, every stroke id).
const clearStart = overlay.indexOf("\tclearAllInk(path: string): number | null {\n");
expect(clearStart).toBeGreaterThan(0);
const clearBody = overlay.slice(clearStart, overlay.indexOf("\n\t}\n", clearStart));
expect(clearBody).toContain("inlineInk.applyRemove(");
expect(clearBody).not.toContain("processFrontMatter");
expect(source).toContain("const n = deleteAllInkOn(path);");

// ---- the stylesheet: which rules hide the status bar -------------------------
interface StatusRule {
	selector: string;
	display: string | null;
	topLevel: boolean;
}
const statusRules: StatusRule[] = [];
postcss.parse(stylesSource).walkRules((rule) => {
	for (const sel of rule.selectors) {
		if (!/\.status-bar\b/.test(sel)) continue;
		let display: string | null = null;
		rule.walkDecls("display", (d) => {
			display = d.value.replace(/\s*!important\s*$/, "").trim();
		});
		statusRules.push({ selector: sel.trim(), display, topLevel: rule.parent?.type === "root" });
	}
});

/** Is Obsidian's `.status-bar` (a child of body) display:none under the plugin's stylesheet? */
function statusBarHidden(bodyClasses: ReadonlySet<string>): boolean {
	let hidden = false;
	for (const r of statusRules) {
		const m = /^body((?:\.[\w-]+)*)\s+\.status-bar$/.exec(r.selector);
		if (!m) throw new Error(`unmodelled status-bar selector: ${r.selector}`);
		const need = m[1]!.split(".").filter(Boolean);
		if (need.every((c) => bodyClasses.has(c)) && r.display === "none") hidden = true;
	}
	return hidden;
}

// ---- fakes: Obsidian vault + metadata cache + body ----------------------------
const NOTE = "Notes/inked.md";

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2.2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 0 },
		createdAt: 0,
	} as InkStroke;
}

/** Obsidian's metadata cache frontmatter: `key: value` lines between the fences. */
function frontmatterOf(content: string): Record<string, unknown> | undefined {
	const parsed = parseMarkdownPage(content);
	if (parsed.frontmatter.length === 0) return undefined;
	const fm: Record<string, unknown> = {};
	for (const line of parsed.frontmatter) {
		const m = /^([^:]+):\s*(.*)$/.exec(line);
		if (m) fm[m[1]!.trim()] = m[2]!.trim().replace(/^"(.*)"$/, "$1");
	}
	return fm;
}

class World {
	contents = new Map<string, string>([[NOTE, "Some prose.\n"]]);
	sidecars = new Map<string, PageData>();
	file = { path: NOTE, extension: "md" };
	active: { path: string; extension: string } | null = this.file;
	body = new Set<string>();
	plugin: any;
	constructor() {
		const world = this;
		this.plugin = {
			// Since 1.4.22 the hiding is opt-in; this probe is about the opted-in behaviour after Delete all ink.
			settings: { hideStatusBarOnInkedNotes: true },
			app: {
				vault: {
					getFileByPath: (p: string) => (p === NOTE ? world.file : null),
					process: async (file: { path: string }, fn: (data: string) => string) => {
						const next = fn(world.contents.get(file.path)!);
						world.contents.set(file.path, next);
						return next;
					},
				},
				metadataCache: {
					getFileCache: (file: { path: string }) => {
						const c = world.contents.get(file.path);
						return c === undefined ? null : { frontmatter: frontmatterOf(c) };
					},
				},
				workspace: { getActiveFile: () => world.active },
			},
			warnUnusablePageId: () => {},
			pageIds: { register: () => ({ kind: "registered" }) },
			persistOwners: () => {},
		};
	}
	host(): InlineInkHost {
		const notePageId = makeNotePageId(isSafePageId).bind(this.plugin);
		const claimNotePageId = makeClaimNotePageId(claimMarkdown, hasFrontmatterBlock, UnreadableFrontmatterError).bind(this.plugin);
		return {
			readPageId: (path) => notePageId(path),
			claimId: (path, proposedId) => claimNotePageId(path, proposedId),
			loadSidecar: async (id): Promise<ParseResult | null> => {
				const p = this.sidecars.get(id);
				return p ? ({ data: structuredClone(p), recovered: false, damaged: false } as ParseResult) : null;
			},
			scheduleSidecar: (id, page) => {
				this.sidecars.set(id, structuredClone(page));
			},
			notify: () => {},
		};
	}
	updateStatusBarClass(store: InlineInkStore): void {
		const doc = {
			body: {
				classList: {
					toggle: (cls: string, force: boolean) => {
						if (force) this.body.add(cls);
						else this.body.delete(cls);
						return force;
					},
					remove: (cls: string) => void this.body.delete(cls),
				},
			},
		};
		makeUpdateStatusBarClass.call(this.plugin, store, doc)();
	}
	statusBarHidden(): boolean {
		return statusBarHidden(this.body);
	}
}

async function drawOneStrokeThenDeleteAll(world: World): Promise<InlineInkStore> {
	const store = new InlineInkStore();
	store.attachHost(world.host());
	// A fresh, unclaimed note is mounted: status bar visible (onLayoutReady / file-open).
	await store.ensureLoaded(NOTE);
	world.updateStatusBarClass(store);
	expect(world.body.has("handwriting-active-page")).toBe(false);
	expect(world.statusBarHidden()).toBe(false);

	// One stroke. The claim writes handwriting-page-id into the frontmatter.
	store.commit(NOTE, stroke("s1"));
	expect(await store.settle()).toBe(true);
	const fm = frontmatterOf(world.contents.get(NOTE)!);
	expect(typeof fm?.["handwriting-page-id"]).toBe("string");
	// metadataCache 'changed' for the active file -> updateStatusBarClass (main.ts:3670-3675).
	world.updateStatusBarClass(store);
	// Intended design: a note WITH ink hides the status bar.
	expect(world.body.has("handwriting-active-page")).toBe(true);
	expect(world.statusBarHidden()).toBe(true);

	// Delete all ink: the command's gates pass, then clearAllInk's applyRemove of every stroke.
	expect(store.deleteAllReadiness(NOTE).kind).toBe("ready");
	const capture = store.captureDeleteAll(NOTE);
	expect(capture?.targets.length).toBe(1);
	const ids = store.strokes(NOTE).map((s) => s.id);
	expect(store.applyRemove(NOTE, ids)).toHaveLength(1);
	expect(store.strokes(NOTE)).toHaveLength(0);
	expect(await store.settle()).toBe(true);
	// The emptiness reached the sidecar.
	const id = fm!["handwriting-page-id"] as string;
	expect(world.sidecars.get(id)?.strokes).toHaveLength(0);
	return store;
}

describe("CSS-1: status bar after Delete all ink", () => {
	// settle() uses window.setTimeout; the node test environment has no window.
	beforeEach(() => {
		vi.stubGlobal("window", globalThis);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("stylesheet precondition: exactly one unconditional rule hides .status-bar, keyed to the body class", () => {
		expect(statusRules).toEqual([
			{ selector: "body.handwriting-active-page .status-bar", display: "none", topLevel: true },
		]);
	});

	it("same session: switching away and back to the note that now has no ink shows the status bar", async () => {
		const world = new World();
		const store = await drawOneStrokeThenDeleteAll(world);
		// Switch to another note, then back (active-leaf-change / file-open).
		world.active = null;
		world.updateStatusBarClass(store);
		expect(world.statusBarHidden()).toBe(false);
		world.active = world.file;
		world.updateStatusBarClass(store);
		// Precondition: the note truly holds no ink.
		expect(store.strokes(NOTE)).toHaveLength(0);
		// CORRECT: a note with no ink keeps Obsidian's status bar.
		expect(world.statusBarHidden(), "status bar hidden on a note with zero strokes (same session)").toBe(false);
	});

	it("after a restart: the note with no ink shows the status bar", async () => {
		const world = new World();
		await drawOneStrokeThenDeleteAll(world);
		// Restart: a fresh window (onunload removed the class; a new body carries none), a fresh store over the
		// same vault; onLayoutReady runs updateStatusBarClass.
		world.body.clear();
		const fresh = new InlineInkStore();
		fresh.attachHost(world.host());
		world.updateStatusBarClass(fresh);
		const hiddenAtLayoutReady = world.statusBarHidden();
		// The overlay mounts and loads the (empty) sidecar.
		await fresh.ensureLoaded(NOTE);
		expect(fresh.strokes(NOTE)).toHaveLength(0);
		// The id line survived the delete (precondition of the mechanism).
		expect(typeof frontmatterOf(world.contents.get(NOTE)!)?.["handwriting-page-id"]).toBe("string");
		world.updateStatusBarClass(fresh);
		// CORRECT: a note with no ink keeps Obsidian's status bar.
		expect(hiddenAtLayoutReady, "status bar hidden at layout-ready on a note with zero strokes").toBe(false);
		expect(world.statusBarHidden(), "status bar hidden after restart on a note with zero strokes").toBe(false);
	});
});
