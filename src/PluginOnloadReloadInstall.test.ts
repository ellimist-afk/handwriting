/**
 * The embeds phase and the live reload phase of onload live in PluginOnloadReload.ts and are installed on
 * HandwritingPlugin.prototype when main.ts loads, right after the other phases; onload calls them in the order
 * their statements had (that order is held in PluginOnloadInstall.test.ts). Four things a type check cannot see
 * are held here, as the install tests of the other split files hold them for theirs.
 *
 * LOAD ORDER. main.ts imports the install function; PluginOnloadReload.ts imports only a type from main, so there
 * is no cycle. This file imports the new file first, and one cell loads main first in a fresh module graph, so a
 * value import added back from main fails here, in either order, at load and not on a device.
 *
 * THE INSTALL. Each phase must be an own property of the prototype with the descriptor a class method has. A phase
 * left out of the install still type-checks, because the interface declares it, and onload would only fail when it
 * reached the call.
 *
 * NO BODY LEFT BEHIND. The class body and PluginOnload.ts declare neither phase, and the new file declares each
 * once.
 *
 * THE CALL. main.ts installs the new file once, after the class closing brace and after the other phases. A
 * dropped call type-checks.
 */
import { describe, expect, it, vi } from "vitest";

import { installPluginOnloadReload } from "./PluginOnloadReload";
import { HandwritingPlugin } from "./main";
import mainRaw from "./main.ts?raw";
import onloadRaw from "./PluginOnload.ts?raw";
import fileRaw from "./PluginOnloadReload.ts?raw";

const MOVED = ["onloadEmbeds", "onloadLiveReload"] as const;

/** Every name the new file takes from main, and nothing else. */
const FROM_MAIN = ["HandwritingPlugin"];

const mainSrc = mainRaw.replace(/\r\n/g, "\n");
const onloadSrc = onloadRaw.replace(/\r\n/g, "\n");
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

describe("embeds and live reload phases on the plugin prototype", () => {
	it("load with the new file imported first, and the install function is exported", () => {
		expect(typeof installPluginOnloadReload).toBe("function");
	});

	it("every phase is a prototype method with a class method's descriptor", () => {
		expectInstalled(HandwritingPlugin.prototype);
	});

	it("each phase is declared once in the new file, and not in PluginOnload.ts or the class", () => {
		const classStart = mainSrc.indexOf("export default class HandwritingPlugin extends Plugin {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = mainSrc.slice(classStart, mainSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = fileSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: HandwritingPlugin\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in PluginOnloadReload.ts`).toBe(1);
			const inOnload = onloadSrc.match(new RegExp(`function ${name}\\(`, "g"));
			expect(inOnload, `${name} still declared in PluginOnload.ts`).toBeNull();
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("main installs once, after the class closing brace and after the other phases", () => {
		const call = "installPluginOnloadReload(HandwritingPlugin.prototype);";
		expect(mainSrc.split(call).length - 1).toBe(1);
		const classStart = mainSrc.indexOf("export default class HandwritingPlugin extends Plugin {");
		const classEnd = mainSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(mainSrc.indexOf(call)).toBeGreaterThan(classEnd);
		expect(mainSrc.indexOf(call)).toBeGreaterThan(mainSrc.indexOf("installPluginOnload(HandwritingPlugin.prototype);"));
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
		const moved = await import("./PluginOnloadReload");
		expect(typeof moved.installPluginOnloadReload).toBe("function");
		expect(main.HandwritingPlugin).not.toBe(HandwritingPlugin);
		expectInstalled(main.HandwritingPlugin.prototype);
	});
});
