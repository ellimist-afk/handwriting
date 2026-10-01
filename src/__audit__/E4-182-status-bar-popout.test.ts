/**
 * E4 probe for audit item 182 (finding id main-2-5): a popout's note decides
 * whether the main window's status bar is hidden.
 *
 * Claim: applyStatusBarVisibility reads workspace.getActiveFile(), which
 * follows the active leaf into a popout window, and stamps the answer on the
 * global document.body, which is always the main window's. Only the main
 * window has a status bar. So with "hide the status bar on inked notes" on,
 * an inked note focused in a popout hides the main window's bar over an
 * ordinary note, and an ordinary note focused in a popout shows the bar over
 * the main window's inked note.
 *
 * Production code driven: the real HandwritingPlugin.applyStatusBarVisibility
 * on a prototype instance (as src/StatusBarUntouched.test.ts does), with the
 * real inlineInk's inkPresence stood in per note. The workspace has two
 * leaves: one in the main window's root split, one in a popout built by
 * test/popoutWindow.ts; the popout leaf is the active one.
 *
 * Asserts the CORRECT behaviour: the main window's body follows the main
 * window's note. The control holds both leaves in the main window and proves
 * the stand-ins stamp and clear the body at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import { makePopoutWindow } from "../../test/popoutWindow";

const CLASS = "handwriting-active-page";
const INKED = { path: "Notes/drawn.md", extension: "md" };
const PLAIN = { path: "Notes/prose.md", extension: "md" };

const g = globalThis as unknown as { document?: unknown };
const realDocument = g.document;
const realPresence = inlineInk.inkPresence.bind(inlineInk);

afterEach(() => {
	g.document = realDocument;
	inlineInk.inkPresence = realPresence;
});

/** The main window's body, as the plugin's bare `document` sees it. */
function mainBody(initial: readonly string[] = []) {
	const seen = new Set(initial);
	const classList = {
		add: (c: string) => void seen.add(c),
		remove: (...cs: string[]) => {
			for (const c of cs) seen.delete(c);
		},
		toggle: (c: string, force?: boolean) => {
			if (force ?? !seen.has(c)) seen.add(c);
			else seen.delete(c);
		},
		contains: (c: string) => seen.has(c),
	};
	const doc = { body: { classList } };
	g.document = doc;
	return { doc, stamped: () => seen.has(CLASS) };
}

/**
 * A workspace with a main-window leaf and a second leaf, the second active.
 * `second` says which window the second leaf lives in.
 */
function pluginWith(main: typeof INKED, active: typeof INKED, second: "popout" | "main") {
	const popout = makePopoutWindow();
	const body = mainBody();
	inlineInk.inkPresence = (p: string) => (p === INKED.path ? "ink" : "none");
	const rootSplit = { name: "rootSplit" };
	const popoutSplit = { name: "popout split" };
	const leaf = (file: typeof INKED, parent: object, ownerDocument: unknown) => ({
		parent,
		view: { file, containerEl: { ownerDocument } },
	});
	const mainLeaf = leaf(main, rootSplit, body.doc);
	const activeLeaf =
		second === "popout" ? leaf(active, popoutSplit, popout.document) : leaf(active, rootSplit, body.doc);
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.settings = { hideStatusBarOnInkedNotes: true };
	plugin.app = {
		workspace: {
			rootSplit,
			activeLeaf,
			getActiveFile: () => activeLeaf.view.file,
			// Obsidian: the most recently active leaf under `root`, or overall with none.
			getMostRecentLeaf: (root?: object) =>
				root === undefined || activeLeaf.parent === root ? activeLeaf : root === rootSplit ? mainLeaf : null,
		},
	};
	return { apply: () => (plugin as unknown as { applyStatusBarVisibility(): void }).applyStatusBarVisibility(), body };
}

describe("E4 item 182 control: both notes in the main window", () => {
	it("the active main-window note decides, inked or not", () => {
		const inked = pluginWith(PLAIN, INKED, "main");
		inked.apply();
		expect(inked.body.stamped()).toBe(true);

		const plain = pluginWith(INKED, PLAIN, "main");
		plain.apply();
		expect(plain.body.stamped()).toBe(false);
	});
});

describe("E4 item 182 probe: a popout's note does not decide the main window's bar", () => {
	it("an inked note focused in a popout leaves the bar over the main window's ordinary note", () => {
		const w = pluginWith(PLAIN, INKED, "popout");
		w.apply();
		expect(w.body.stamped()).toBe(false);
	});

	it("an ordinary note focused in a popout still hides the bar over the main window's inked note", () => {
		const w = pluginWith(INKED, PLAIN, "popout");
		w.apply();
		expect(w.body.stamped()).toBe(true);
	});
});
