/**
 * AUDIT PROBE issue-16-1 (read-only audit of 1.4.21, tag 1a05f62c).
 *
 * Claim: styles.css:2355 `body.handwriting-active-page .status-bar
 * { display: none }` plus main.ts:3567-3573 `updateStatusBarClass` hide
 * Obsidian's app-wide status bar whenever the ACTIVE note is a Handwriting
 * page (any ink, or a handwriting-page-id in frontmatter), with Infinite
 * Canvas off, with no setting to keep it, and on the MAIN window's body even
 * when the active note lives in a popout.
 *
 * Production code driven:
 *  - updateStatusBarClass, sliced verbatim out of main.ts and executed with
 *    `this` = a plugin stand-in (a Proxy that logs which members it reads);
 *  - notePageId, sliced verbatim out of main.ts (the inline host's readPageId,
 *    main.ts:2034) with the real isSafePageId;
 *  - the real InlineInkStore (isHandwritingPage, commit);
 *  - the real styles.css, parsed with postcss, every rule that targets the
 *    `.status-bar` element evaluated against the body classes the sliced
 *    closure left behind.
 *
 * Assertions state the CORRECT behaviour (Alan's ruling on the 1.4.19 report,
 * commit 707462be: the status bar is visible by default): green = no bug,
 * red = bug. Every red test first asserts its trigger precondition.
 */
import { describe, expect, it } from "vitest";
import { transformSync } from "esbuild";
import postcss from "postcss";
import mainSource from "../main.ts?raw";
import css from "../../styles.css?raw";
import { InlineInkStore } from "../inline/InlineInkStore";
import { isSafePageId, newPageId } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const source = mainSource.replace(/\r\n/g, "\n");

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
const makeUpdateStatusBarClass = new Function("document", "inlineInk", methodCode) as (doc: unknown, ink: InlineInkStore) => () => void;

// Wiring preconditions: the closure runs on these triggers (main.ts:3574,
// 3667, 3669-3675, 3677-3680), and onunload removes the class (main.ts:4633).
expect(source).toContain(
	'this.registerEvent(this.app.workspace.on("active-leaf-change", updateStatusBarClass));'
);
expect(source).toContain('this.registerEvent(this.app.workspace.on("file-open", updateStatusBarClass));');
expect(source).toContain(
	"\t\t\tthis.app.metadataCache.on(\"changed\", (file) => {\n" +
		"\t\t\t\tif (file.path === this.app.workspace.getActiveFile()?.path) {\n" +
		"\t\t\t\t\tupdateStatusBarClass();"
);
expect(source).toContain(
	"\t\tthis.app.workspace.onLayoutReady(() => {\n\t\t\tif (this.unloaded) return;\n\t\t\tupdateStatusBarClass();\n\t\t});"
);
// The inline host's readPageId is notePageId (main.ts:2034).
expect(source).toContain("readPageId: (path) => this.notePageId(path),");

// ---- slice notePageId (main.ts:4998-5013), verbatim --------------------------
const npStart = "\tprivate notePageId(path: string): string | null {\n";
expect(source.split(npStart)).toHaveLength(2);
const ns = source.indexOf(npStart) + npStart.length;
const ne = source.indexOf("\n\t}\n", ns);
const npBody = source.slice(ns, ne);
expect(npBody).toContain('fm?.["handwriting-page-id"]');
const notePageId = new Function(
	"isSafePageId",
	transformSync(`return function notePageId(path: string): string | null {\n${npBody}\n};`, {
		loader: "ts",
		target: "es2022",
	}).code
)(isSafePageId) as (this: unknown, path: string) => string | null;

// ---- the real stylesheet: what does it do to the status bar? ----------------
const cssRoot = postcss.parse(css);
// Precondition: the stylesheet was actually parsed and holds the claimed rule.
let claimedRuleSeen = false;
cssRoot.walkRules((r) => {
	if (r.selectors.some((s) => s.trim().replace(/\s+/g, " ") === "body.handwriting-active-page .status-bar")) {
		claimedRuleSeen = true;
	}
});
expect(claimedRuleSeen).toBe(true);

interface ModelEl {
	tag: string;
	classes: Set<string>;
}
interface Hit {
	selector: string;
	display: string;
	important: boolean;
	line: number | undefined;
	spec: [number, number];
	order: number;
}

/** tag?(.class)* only; anything else is reported as unevaluated. */
function parseCompound(c: string): { tag: string | null; classes: string[] } | null {
	const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)$/.exec(c);
	if (!m || (!m[1] && !m[2])) return null;
	return { tag: m[1] ?? null, classes: m[2] ? m[2].slice(1).split(".") : [] };
}

function compoundMatches(c: { tag: string | null; classes: string[] }, el: ModelEl): boolean {
	if (c.tag && c.tag !== el.tag) return false;
	return c.classes.every((k) => el.classes.has(k));
}

/**
 * The winning plugin `display` for Obsidian's `.status-bar` element in a
 * window whose <html>/<body> carry these classes. Chain modelled on Obsidian's
 * DOM: html > body > div.app-container > div.status-bar.
 */
function statusBarDisplay(bodyClasses: Set<string>): {
	winner: Hit | null;
	hits: Hit[];
	unevaluated: string[];
} {
	const chain: ModelEl[] = [
		{ tag: "html", classes: new Set() },
		{ tag: "body", classes: bodyClasses },
		{ tag: "div", classes: new Set(["app-container"]) },
	];
	const target: ModelEl = { tag: "div", classes: new Set(["status-bar"]) };
	const hits: Hit[] = [];
	const unevaluated: string[] = [];
	let order = 0;
	cssRoot.walkRules((rule) => {
		const displays: { value: string; important: boolean }[] = [];
		rule.walkDecls("display", (d) => {
			displays.push({ value: d.value.trim(), important: !!d.important });
		});
		if (displays.length === 0) return;
		for (const raw of rule.selectors) {
			const sel = raw.trim().replace(/\s+/g, " ");
			if (!/\.status-bar(?![\w-])/.test(sel)) continue;
			const parts = sel.split(" ").map(parseCompound);
			if (parts.some((p) => p === null)) {
				unevaluated.push(sel);
				continue;
			}
			const compounds = parts as { tag: string | null; classes: string[] }[];
			const last = compounds[compounds.length - 1]!;
			if (!compoundMatches(last, target)) continue; // targets a child, not the bar
			// Descendant combinators only: greedy right-to-left over the ancestors.
			let ai = chain.length - 1;
			let ok = true;
			for (let ci = compounds.length - 2; ci >= 0; ci--) {
				while (ai >= 0 && !compoundMatches(compounds[ci]!, chain[ai]!)) ai--;
				if (ai < 0) {
					ok = false;
					break;
				}
				ai--;
			}
			if (!ok) continue;
			const spec: [number, number] = [
				compounds.reduce((n, c) => n + c.classes.length, 0),
				compounds.reduce((n, c) => n + (c.tag ? 1 : 0), 0),
			];
			for (const d of displays) {
				hits.push({
					selector: sel,
					display: d.value,
					important: d.important,
					line: rule.source?.start?.line,
					spec,
					order: order++,
				});
			}
		}
	});
	const rank = (h: Hit) => [h.important ? 1 : 0, h.spec[0], h.spec[1], h.order];
	let winner: Hit | null = null;
	for (const h of hits) {
		if (!winner) {
			winner = h;
			continue;
		}
		const a = rank(h);
		const b = rank(winner);
		for (let i = 0; i < a.length; i++) {
			if (a[i]! !== b[i]!) {
				if (a[i]! > b[i]!) winner = h;
				break;
			}
		}
	}
	return { winner, hits, unevaluated };
}

// ---- a window, a vault, a plugin stand-in -----------------------------------
function makeDoc() {
	const classes = new Set<string>();
	return {
		classes,
		body: {
			classList: {
				toggle(name: string, force?: boolean): boolean {
					const on = force === undefined ? !classes.has(name) : force;
					if (on) classes.add(name);
					else classes.delete(name);
					return on;
				},
				contains: (name: string) => classes.has(name),
				add: (name: string) => void classes.add(name),
				remove: (name: string) => void classes.delete(name),
			},
		},
	};
}

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 0 },
		createdAt: 0,
	} as InkStroke;
}

function world() {
	const files = new Map<string, { path: string; extension: string }>();
	const frontmatter = new Map<string, Record<string, unknown>>();
	let active: { path: string; extension: string } | null = null;
	const app = {
		vault: { getFileByPath: (p: string) => files.get(p) ?? null },
		metadataCache: {
			getFileCache: (f: { path: string }) => {
				const fm = frontmatter.get(f.path);
				return fm ? { frontmatter: fm } : {};
			},
		},
		workspace: { getActiveFile: () => active },
	};
	// Everything the sliced code reads off `this` is logged: if it consulted a
	// setting or the Infinite Canvas mode, the name shows up here.
	const reads: string[] = [];
	const pluginTarget = {
		app,
		warnUnusablePageId: () => {},
	};
	const plugin = new Proxy(pluginTarget, {
		get(t, k, r) {
			reads.push(String(k));
			return Reflect.get(t, k, r);
		},
	});
	const claims: string[] = [];
	const ink = new InlineInkStore();
	// As main.ts:2033-2047, with readPageId the sliced notePageId.
	ink.attachHost({
		readPageId: (path) => notePageId.call(plugin, path),
		claimId: async (path, proposedId) => {
			claims.push(path);
			frontmatter.set(path, { ...(frontmatter.get(path) ?? {}), "handwriting-page-id": proposedId });
			return { pageId: proposedId };
		},
		loadSidecar: async () => null,
		scheduleSidecar: () => {},
		scheduleSidecarNow: async () => {},
		notify: () => {},
	});
	const mainDoc = makeDoc();
	// `document` inside the closure is the plugin module's global: the MAIN window's.
	const update = makeUpdateStatusBarClass.call(plugin, mainDoc, ink);
	return {
		files,
		frontmatter,
		ink,
		mainDoc,
		reads,
		claims,
		update,
		addNote(path: string, fm?: Record<string, unknown>) {
			const f = { path, extension: "md" };
			files.set(path, f);
			if (fm) frontmatter.set(path, fm);
			return f;
		},
		activate(f: { path: string; extension: string } | null) {
			active = f;
		},
	};
}

function report(tag: string, w: ReturnType<typeof world>) {
	const res = statusBarDisplay(w.mainDoc.classes);
	console.log(
		`[issue-16-1 ${tag}]`,
		JSON.stringify({
			bodyClasses: [...w.mainDoc.classes],
			winner: res.winner,
			hits: res.hits.map((h) => `${h.selector} {display:${h.display}} @styles.css:${h.line}`),
			unevaluated: res.unevaluated,
			pluginReads: [...new Set(w.reads)],
		})
	);
	return res;
}

describe("issue-16-1: the status bar on a Handwriting page, Infinite Canvas off, default settings", () => {
	it("CONTROL: an ordinary note with no ink keeps Obsidian's status bar", () => {
		const w = world();
		const note = w.addNote("Plain.md");
		w.activate(note);
		w.update();
		expect(w.ink.isHandwritingPage("Plain.md")).toBe(false);
		expect(w.mainDoc.classes.has("handwriting-active-page")).toBe(false);
		const res = report("control", w);
		expect(res.winner?.display ?? "(obsidian default)").not.toBe("none");
	});

	it("a note carrying a handwriting-page-id keeps Obsidian's status bar", () => {
		const w = world();
		const note = w.addNote("Inked.md", { "handwriting-page-id": newPageId() });
		// No frontmatter key for Infinite Canvas: the note follows the global
		// setting, which defaults off (stock Obsidian note).
		expect(w.frontmatter.get("Inked.md")).not.toHaveProperty("handwriting-canvas");
		w.activate(note);
		w.update(); // active-leaf-change / file-open / onLayoutReady all call exactly this
		// Since 1.4.22 the hiding is a setting, off by default: the note is a Handwriting page and the body is NOT stamped.
		expect(w.ink.isHandwritingPage("Inked.md")).toBe(true);
		expect(w.mainDoc.classes.has("handwriting-active-page"), "default settings stamped the body").toBe(false);
		const res = report("page-id note", w);
		// Since 1.4.22 the method consults the setting first, and with it off reads nothing else.
		expect([...new Set(w.reads)]).toContain("settings");
		// CORRECT: visible by default.
		expect(res.winner?.display ?? "(obsidian default)", "status bar hidden by plugin CSS").not.toBe("none");
	});

	it("one stroke on an ordinary note keeps Obsidian's status bar", async () => {
		const w = world();
		const note = w.addNote("Ordinary.md");
		w.activate(note);
		w.update();
		expect(w.mainDoc.classes.has("handwriting-active-page")).toBe(false);
		// The user draws one stroke (pen, mouse or finger all commit here).
		w.ink.commit("Ordinary.md", stroke("s1"));
		for (let i = 0; i < 10; i++) await Promise.resolve();
		// The claim wrote the id; Obsidian's metadata "changed" for the active
		// file calls updateStatusBarClass (main.ts:3669-3675).
		w.update();
		// The note became a Handwriting page; with the setting off by default the body is not stamped.
		expect(w.ink.isHandwritingPage("Ordinary.md")).toBe(true);
		expect(w.mainDoc.classes.has("handwriting-active-page"), "default settings stamped the body").toBe(false);
		const res = report("one stroke", w);
		expect(res.winner?.display ?? "(obsidian default)", "status bar hidden by plugin CSS").not.toBe("none");
	});

	it("an inked note focused in a popout does not hide the MAIN window's status bar", () => {
		const w = world();
		const inked = w.addNote("Popout.md", { "handwriting-page-id": newPageId() });
		// getActiveFile() follows the active leaf into the popout window.
		w.activate(inked);
		w.update();
		// PRECONDITION: the closure has no handle on the leaf's window: it only
		// touches the `document` it closed over (the main window's).
		expect(methodBody).not.toMatch(/activeDocument|ownerDocument|doc\b|win\b/);
		expect(w.ink.isHandwritingPage("Popout.md")).toBe(true);
		const res = report("popout", w);
		expect(
			w.mainDoc.classes.has("handwriting-active-page"),
			"main window body stamped by a note that lives in a popout"
		).toBe(false);
		expect(res.winner?.display ?? "(obsidian default)").not.toBe("none");
	});
});
