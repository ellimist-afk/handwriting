/**
 * The bug-report header's "os" field. Obsidian's Platform.isMacOS is true on iPhone and iPad as well as on a Mac,
 * so a label that tests isMacOS before isIosApp reports every iOS device as "macos". The function is sliced out of
 * main.ts, compiled, and run against a Platform object that answers the way Obsidian does on each device.
 */
import { describe, expect, it } from "vitest";
import { transformSync } from "esbuild";
import mainSource from "./main.ts?raw";

const source = mainSource.replace(/\r\n/g, "\n");
const START = "function platformOs(): string {";
const END = "\n}\n";

type Flags = Partial<Record<"isWin" | "isMacOS" | "isLinux" | "isIosApp" | "isAndroidApp", boolean>>;

function platformOs(flags: Flags): string {
	expect(source.split(START), "platformOs is in main.ts once").toHaveLength(2);
	const at = source.indexOf(START);
	const end = source.indexOf(END, at);
	expect(end).toBeGreaterThan(at);
	const js = transformSync(source.slice(at, end + END.length), { loader: "ts" }).code;
	const run = new Function("Platform", `${js}\nreturn platformOs();`) as (p: Flags) => string;
	return run(flags);
}

describe("bug-report os label", () => {
	it("labels an iPhone or iPad ios, although Obsidian also sets isMacOS there", () => {
		expect(platformOs({ isMacOS: true, isIosApp: true })).toBe("ios");
	});
	it("labels a Mac macos", () => {
		expect(platformOs({ isMacOS: true })).toBe("macos");
	});
	it("labels Windows, Linux and Android as before", () => {
		expect(platformOs({ isWin: true })).toBe("windows");
		expect(platformOs({ isLinux: true })).toBe("linux");
		expect(platformOs({ isAndroidApp: true })).toBe("android");
		expect(platformOs({ isLinux: true, isAndroidApp: true })).toBe("android");
	});
	it("labels an unknown host unknown", () => {
		expect(platformOs({})).toBe("unknown");
	});
});
