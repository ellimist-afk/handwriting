/**
 * The ink controls and setting appliers live in PluginApply.ts and are
 * installed on HandwritingPlugin.prototype when main.ts loads. Four things a
 * type check cannot see are held here, as the install tests of the other split
 * files hold them for theirs.
 *
 * LOAD ORDER. main.ts imports the install function; PluginApply.ts imports only
 * a type from main, so there is no cycle. This file imports the new file first,
 * and one cell loads main first in a fresh module graph, so a value import added
 * back from main fails here, in either order, at load and not on a device.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the
 * descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when that
 * path ran on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * new file declares each once, so a half-finished move cannot pass with the old
 * copy still shadowing the new one.
 *
 * ONE DOOR. The new file names nothing of main beyond the list below.
 */
import { describe, expect, it, vi } from "vitest";

import { installPluginApply } from "./PluginApply";
import { HandwritingPlugin } from "./main";
import { clearGatedCommandAction, setGatedCommandAction } from "./CommandPaletteSplit";
import { getInlineTool } from "./inline/InkOverlay";
import { markMousePutDown } from "./inline/MouseInk";
import mainRaw from "./main.ts?raw";
import fileRaw from "./PluginApply.ts?raw";

const MOVED = [
	"pickUpNib",
	"setInkColor",
	"setInkSize",
	"setEraserSize",
	"enterTipMode",
	"applyStripFoldOrder",
	"applyMouseInkUiFanout",
	"tipModeOffNotice",
	"armTipModeInput",
	"applySlidesInk",
	"applyPaper",
	"applyPaperTo",
	"reloadPanesHidden",
	"applyStatusBarVisibility",
	"registeredGatedCommandIds",
	"appCommandRegistry",
	"gatedCommandRemovalAvailable",
	"removeGatedCommand",
	"applyGatedCommandRegistration",
	"showScribbleHintIfDue",
	"checkEinkHint",
] as const;

/** Every name the new file takes from main, and nothing else. */
const FROM_MAIN = ["HandwritingPlugin"];

const mainSrc = mainRaw.replace(/\r\n/g, "\n");
const fileSrc = fileRaw.replace(/\r\n/g, "\n");

/** A plugin built without its constructor, as the other install tests build theirs: the prototype and the fields a method reads. */
function barePlugin(fields: Record<string, unknown> = {}): HandwritingPlugin {
	const plugin = Object.create(HandwritingPlugin.prototype) as HandwritingPlugin;
	for (const [key, value] of Object.entries(fields)) {
		Object.defineProperty(plugin, key, { value, writable: true, configurable: true });
	}
	return plugin;
}

function expectInstalled(proto: object): void {
	for (const name of MOVED) {
		const d = Object.getOwnPropertyDescriptor(proto, name);
		expect(d, `${name} is not on the prototype`).toBeDefined();
		expect(typeof d!.value, name).toBe("function");
		expect({ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable }, name).toEqual({
			writable: true,
			enumerable: false,
			configurable: true,
		});
	}
}

describe("ink controls and setting appliers on the plugin prototype", () => {
	it("load with the new file imported first, and moved methods run on a bare plugin", () => {
		expect(typeof installPluginApply).toBe("function");

		const plugin = barePlugin();
		markMousePutDown();
		expect(plugin.tipModeOffNotice()).toBe("Handwriting: cursor");
		expect(plugin.tipModeOffNotice()).toBe(`Handwriting: ${getInlineTool()}`);

		const own: string[] = [];
		const registry: string[] = [];
		const both = barePlugin({
			removeCommand: (id: string) => own.push(id),
			app: { commands: { removeCommand: (id: string) => registry.push(id) } },
			manifest: { id: "handwriting" },
		});
		const appOnly = barePlugin({
			removeCommand: undefined,
			app: { commands: { removeCommand: (id: string) => registry.push(id) } },
			manifest: { id: "handwriting" },
		});
		const neither = barePlugin({ removeCommand: undefined, app: {} });
		expect(both.gatedCommandRemovalAvailable()).toBe(true);
		expect(appOnly.gatedCommandRemovalAvailable()).toBe(true);
		expect(neither.gatedCommandRemovalAvailable()).toBe(false);

		both.removeGatedCommand("inline-tool-eraser");
		expect(own).toEqual(["inline-tool-eraser"]);
		expect(registry).toEqual(["handwriting:inline-tool-eraser"]);

		const defs = barePlugin({
			gatedCommandDefs: new Map<string, unknown>([
				["gated-a", {}],
				["gated-b", {}],
				["gated-c", {}],
			]),
		});
		setGatedCommandAction("gated-b", () => {});
		try {
			expect(defs.registeredGatedCommandIds()).toEqual(["gated-a", "gated-c"]);
		} finally {
			clearGatedCommandAction("gated-b");
		}

		const classes = new Set(["handwriting-paper-lines", "handwriting-paper-grid", "handwriting-paper-dots", "other"]);
		const classList = {
			remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
			add: (name: string) => classes.add(name),
		};
		const doc = { body: { classList } } as unknown as Document;
		plugin.applyPaperTo(doc, "grid");
		expect([...classes].sort()).toEqual(["handwriting-paper-grid", "other"]);
		plugin.applyPaperTo(doc, "none");
		expect([...classes]).toEqual(["other"]);
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		expectInstalled(HandwritingPlugin.prototype);
	});

	it("each moved name is declared once in the new file and not in the class", () => {
		const classStart = mainSrc.indexOf("export default class HandwritingPlugin extends Plugin {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = mainSrc.slice(classStart, mainSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = fileSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: HandwritingPlugin\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in PluginApply.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("main installs once, after the class closing brace", () => {
		const call = "installPluginApply(HandwritingPlugin.prototype);";
		expect(mainSrc.split(call).length - 1).toBe(1);
		const classStart = mainSrc.indexOf("export default class HandwritingPlugin extends Plugin {");
		const classEnd = mainSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(mainSrc.indexOf(call)).toBeGreaterThan(classEnd);
	});

	it("the new file takes exactly the listed names from main, as types", () => {
		const imports = [...fileSrc.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"\.\/main";/g)];
		expect(imports.length).toBeGreaterThan(0);
		for (const m of imports) expect(m[1], "the import from main is type-only").toBeDefined();
		const names = imports
			.flatMap((m) => m[2]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_MAIN].sort());
	});

	it("load with main imported first in a fresh module graph, and the install is the same", async () => {
		vi.resetModules();
		const main = await import("./main");
		const moved = await import("./PluginApply");
		expect(typeof moved.installPluginApply).toBe("function");
		expect(main.HandwritingPlugin).not.toBe(HandwritingPlugin);
		expectInstalled(main.HandwritingPlugin.prototype);
	});
});
