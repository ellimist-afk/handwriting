/**
 * The phases of onload live in PluginOnload.ts and PluginOnloadReload.ts and are installed on
 * HandwritingPlugin.prototype when main.ts loads; onload calls them in the order
 * their statements had. PluginOnloadReload.ts holds the embeds and live reload phases, and its own
 * install test is PluginOnloadReloadInstall.test.ts; this file holds the other eight and the order
 * of all ten. Five things a type check cannot see are held here, as
 * the install tests of the other split files hold them for theirs.
 *
 * LOAD ORDER. main.ts imports the install function; PluginOnload.ts imports only
 * a type from main, so there is no cycle. This file imports the new file first,
 * and one cell loads main first in a fresh module graph, so a value import added
 * back from main fails here, in either order, at load and not on a device.
 *
 * THE INSTALL. Each phase must be an own property of the prototype with the
 * descriptor a class method has. A phase left out of the install still
 * type-checks, because the interface declares it, and onload would only fail
 * when it reached the call.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the phases, and the new
 * file declares each once.
 *
 * THE ORDER. onload runs the phases, the settings load, the pending PDF
 * deletes and the command registrations in the order the statements had. A
 * dropped or swapped call type-checks.
 *
 * THE AWAITS. onload waits for the device phase and for the settings load, so
 * nothing after either runs before it resolves. A dropped await type-checks.
 */
import { describe, expect, it, vi } from "vitest";

import { installPluginOnload } from "./PluginOnload";
import { HandwritingPlugin } from "./main";
import mainRaw from "./main.ts?raw";
import fileRaw from "./PluginOnload.ts?raw";

const MOVED = [
	"onloadDevice",
	"onloadStore",
	"onloadViews",
	"onloadNoteChrome",
	"onloadVaultEvents",
	"onloadWorkspace",
	"onloadFlushAndForeground",
	"onloadPageIdWatch",
] as const;

/** What onload calls, in the order the statements had. */
const ORDER = [
	"onloadDevice",
	"onloadStore",
	"loadSettings",
	"attachPdfPendingDeletes",
	"onloadViews",
	"onloadEmbeds",
	"onloadNoteChrome",
	"onloadLiveReload",
	"registerCommands",
	"onloadVaultEvents",
	"onloadWorkspace",
	"onloadFlushAndForeground",
	"onloadPageIdWatch",
] as const;

/** Every name the new file takes from main, and nothing else. */
const FROM_MAIN = ["HandwritingPlugin"];

const mainSrc = mainRaw.replace(/\r\n/g, "\n");
const fileSrc = fileRaw.replace(/\r\n/g, "\n");

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

/**
 * A plugin built without its constructor whose onload steps only record their names. A step named in `held`
 * returns a promise that stays pending until its release is called.
 */
function recordingPlugin(held: readonly string[] = []): {
	plugin: HandwritingPlugin;
	calls: string[];
	release: Map<string, () => void>;
} {
	const plugin = Object.create(HandwritingPlugin.prototype) as HandwritingPlugin;
	const calls: string[] = [];
	const release = new Map<string, () => void>();
	for (const name of ORDER) {
		const step = (): Promise<void> | void => {
			calls.push(name);
			if (!held.includes(name)) return undefined;
			return new Promise<void>((resolve) => release.set(name, resolve));
		};
		Object.defineProperty(plugin, name, { value: step, writable: true, configurable: true });
	}
	return { plugin, calls, release };
}

/** Lets every queued microtask and timer of this tick run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("phases of onload on the plugin prototype", () => {
	it("load with the new file imported first, and onload runs every step once in the old order", async () => {
		expect(typeof installPluginOnload).toBe("function");
		const { plugin, calls } = recordingPlugin();
		await plugin.onload();
		expect(calls).toEqual([...ORDER]);
	});

	it("onload waits for the device phase and the settings load before the next step", async () => {
		const { plugin, calls, release } = recordingPlugin(["onloadDevice", "loadSettings"]);
		const done = plugin.onload();
		await settle();
		expect(calls).toEqual(["onloadDevice"]);
		release.get("onloadDevice")!();
		await settle();
		expect(calls).toEqual(["onloadDevice", "onloadStore", "loadSettings"]);
		await settle();
		expect(calls).toEqual(["onloadDevice", "onloadStore", "loadSettings"]);
		release.get("loadSettings")!();
		await done;
		expect(calls).toEqual([...ORDER]);
	});

	it("every phase is a prototype method with a class method's descriptor", () => {
		expectInstalled(HandwritingPlugin.prototype);
	});

	it("each phase is declared once in PluginOnload.ts and not in the class", () => {
		const classStart = mainSrc.indexOf("export default class HandwritingPlugin extends Plugin {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = mainSrc.slice(classStart, mainSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = fileSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: HandwritingPlugin\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in PluginOnload.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the provider for the reading view font reference is initialised once, in the note chrome phase", () => {
		const start = fileSrc.indexOf("function onloadNoteChrome(this: HandwritingPlugin): void {");
		expect(start, "the note chrome phase").toBeGreaterThan(-1);
		const next = fileSrc.indexOf("\n\t}\n", start);
		expect(next).toBeGreaterThan(start);
		const body = fileSrc.slice(start, next);
		expect(body.split("initEmbedInkFontRef(").length - 1).toBe(1);
	});

	it("main installs once, after the class closing brace", () => {
		const call = "installPluginOnload(HandwritingPlugin.prototype);";
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
		const moved = await import("./PluginOnload");
		expect(typeof moved.installPluginOnload).toBe("function");
		expect(main.HandwritingPlugin).not.toBe(HandwritingPlugin);
		expectInstalled(main.HandwritingPlugin.prototype);
	});
});
