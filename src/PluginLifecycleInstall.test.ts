/**
 * The unload, persistence and slides ink start methods live in
 * PluginLifecycle.ts and are installed on HandwritingPlugin.prototype when
 * main.ts loads. Four things a type check cannot see are held here, as the
 * install tests of the other split files hold them for theirs.
 *
 * LOAD ORDER. main.ts imports the install function, and the new file imports
 * one value back (hideOwnedNotices, read at call time), so the two modules form
 * a cycle. This file imports the new file first, and one cell loads main first
 * in a fresh module graph, so a cycle that only works in the usual order fails
 * here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the
 * descriptor a class method has. onunload is the one Obsidian calls by name;
 * left out of the install it would still type-check, because the interface
 * declares it, and the plugin would stop cleaning up on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * new file declares each once.
 *
 * ONE DOOR. The new file names nothing of main beyond the list below, and only
 * hideOwnedNotices as a value.
 */
import { describe, expect, it, vi } from "vitest";

import { installPluginLifecycle } from "./PluginLifecycle";
import { HandwritingPlugin } from "./main";
import mainRaw from "./main.ts?raw";
import fileRaw from "./PluginLifecycle.ts?raw";

const MOVED = [
	"onunload",
	"showWhatsNewIfDue",
	"syncRecordingBadge",
	"guardEmptyTrace",
	"flushOnHide",
	"finishPersistence",
	"openPenDiagnostics",
	"startSlidesInk",
] as const;

/** Every name the new file takes from main, and nothing else; the values among them. */
const FROM_MAIN = ["HandwritingPlugin", "hideOwnedNotices"];
const VALUES_FROM_MAIN = ["hideOwnedNotices"];

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

describe("unload, persistence and slides ink start on the plugin prototype", () => {
	it("load with the new file imported first, and onunload sets unloaded before anything else", () => {
		expect(typeof installPluginLifecycle).toBe("function");
		const target = Object.create(HandwritingPlugin.prototype) as HandwritingPlugin;
		const seen: string[] = [];
		const plugin = new Proxy(target, {
			get(t, key, receiver) {
				seen.push(`get ${String(key)}`);
				return Reflect.get(t, key, receiver);
			},
			set(t, key, value, receiver) {
				seen.push(`set ${String(key)}`);
				return Reflect.set(t, key, value, receiver);
			},
		});
		const onunload = plugin.onunload;
		seen.length = 0;
		try {
			onunload.call(plugin);
		} catch {
			// A bare plugin may lack what later steps read; only the first step is held here.
		}
		expect(seen[0]).toBe("set unloaded");
		expect(target.unloaded).toBe(true);
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
			expect(inFile?.length ?? 0, `${name} in PluginLifecycle.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("main installs once, after the class closing brace", () => {
		const call = "installPluginLifecycle(HandwritingPlugin.prototype);";
		expect(mainSrc.split(call).length - 1).toBe(1);
		const classStart = mainSrc.indexOf("export default class HandwritingPlugin extends Plugin {");
		const classEnd = mainSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(mainSrc.indexOf(call)).toBeGreaterThan(classEnd);
	});

	it("the new file takes exactly the listed names from main, and only hideOwnedNotices as a value", () => {
		const imports = [...fileSrc.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"\.\/main";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const entries = imports.flatMap((m) =>
			m[2]!
				.split(",")
				.map((n) => n.trim())
				.filter(Boolean)
				.map((n) => ({ name: n.replace(/^type\s+/, ""), value: m[1] === undefined && !n.startsWith("type ") }))
		);
		expect(entries.map((e) => e.name).sort()).toEqual([...FROM_MAIN].sort());
		expect(entries.filter((e) => e.value).map((e) => e.name).sort()).toEqual([...VALUES_FROM_MAIN].sort());
	});

	it("load with main imported first in a fresh module graph, and the install is the same", async () => {
		vi.resetModules();
		const main = await import("./main");
		const moved = await import("./PluginLifecycle");
		expect(typeof moved.installPluginLifecycle).toBe("function");
		expect(main.HandwritingPlugin).not.toBe(HandwritingPlugin);
		expectInstalled(main.HandwritingPlugin.prototype);
		expect(typeof main.hideOwnedNotices).toBe("function");
	});
});
