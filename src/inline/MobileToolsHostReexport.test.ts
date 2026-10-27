/**
 * The type of what the strip takes from its host lives in MobileToolsHost.ts, and MobileTools.ts re-exports it, so
 * every importer keeps its import line. A type leaves no code, so the things held here are about the files, not
 * about a value.
 *
 * LOAD. The host file must import no value from MobileTools.ts (or from anything that imports it back): it is
 * loaded by files that MobileTools.ts itself loads, and a value import added back would make a cycle that only
 * fails on a device. It names the strip only as a type.
 *
 * THE DOOR. MobileTools.ts must keep exporting the type under its old name. A test that imports
 * `type MobileToolsHost` from "./MobileTools" still compiles only while the re-export is there; the compile
 * check below fails the type check, not the run, when it goes.
 */
import { describe, expect, it } from "vitest";

import type { MobileToolsHost as FromHostFile } from "./MobileToolsHost";
import type { MobileToolsHost as FromStrip } from "./MobileTools";
import hostRaw from "./MobileToolsHost.ts?raw";
import stripRaw from "./MobileTools.ts?raw";

const hostSrc = hostRaw.replace(/\r\n/g, "\n");
const stripSrc = stripRaw.replace(/\r\n/g, "\n");

/** Fails the type check if the two names stop being the one type. */
type SameType = [FromHostFile] extends [FromStrip] ? ([FromStrip] extends [FromHostFile] ? true : never) : never;
const sameType: SameType = true;

describe("the strip host type lives in MobileToolsHost.ts", () => {
	it("is the same type under both names", () => {
		expect(sameType).toBe(true);
	});

	it("the host file declares the interface once and is the only place that does", () => {
		expect(hostSrc.match(/export interface MobileToolsHost \{/g)).toHaveLength(1);
		expect(stripSrc).not.toMatch(/interface MobileToolsHost\b/);
	});

	it("the host file imports nothing from the strip", () => {
		const imports = hostSrc.match(/^import .*$/gm) ?? [];
		expect(imports.length).toBeGreaterThan(0);
		for (const line of imports) expect(line, line).not.toMatch(/MobileTools["']|MobileToolsBuild|MobileToolsDrag/);
		expect(hostSrc).not.toMatch(/from "\.\/MobileTools"/);
	});

	it("MobileTools.ts re-exports the type and imports it for its own uses", () => {
		expect(stripSrc).toContain('export type { MobileToolsHost } from "./MobileToolsHost";');
		expect(stripSrc).toContain('import type { MobileToolsHost } from "./MobileToolsHost";');
	});
});
