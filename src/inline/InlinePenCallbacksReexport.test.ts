/**
 * The pen router's host callbacks interface lives in InlinePenCallbacks.ts and
 * InlinePenRouter.ts re-exports it as a type, so every importer keeps its import
 * line. A type check holds the importers; three things it cannot see are held
 * here.
 *
 * ONE DECLARATION. InlinePenRouter.ts declares no interface of that name, and
 * the callbacks file declares it once, so a half-finished move cannot pass with
 * an old copy still answering to the importers.
 *
 * TYPES ONLY. The callbacks file imports types only and exports no value, so it
 * stays out of the load order and out of the bundle.
 *
 * THE MEMBERS. The interface's member names are pinned, so a member dropped or
 * renamed in the move shows here even where no caller is typed against it.
 */
import { describe, expect, it } from "vitest";

import * as callbacks from "./InlinePenCallbacks";
import routerRaw from "./InlinePenRouter.ts?raw";
import callbacksRaw from "./InlinePenCallbacks.ts?raw";

const MEMBERS = [
	"onPenDown",
	"onViewportInput",
	"onAllContactsLifted",
	"onBeforePenDown",
	"onPenHover",
	"onPenLeave",
	"onPinch",
	"overscrollAllowancePx",
	"onOverscrollPull",
	"onOverscrollRelease",
	"onPenRaw",
	"onPenMove",
	"onPenUp",
	"penOff",
	"claimBandContact",
	"describeChrome",
	"onStrokeAbandoned",
	"fingerInk",
	"pinchZoom",
	"onFingerInkCancelled",
	"onHandOnGlass",
] as const;

const routerSrc = routerRaw.replace(/\r\n/g, "\n");
const callbacksSrc = callbacksRaw.replace(/\r\n/g, "\n");

describe("the pen router's callbacks interface lives in InlinePenCallbacks.ts", () => {
	it("is declared once in the callbacks file and never in InlinePenRouter.ts", () => {
		expect(callbacksSrc.match(/^export interface InlinePenCallbacks \{/gm)?.length ?? 0).toBe(1);
		expect(routerSrc).not.toMatch(/\binterface InlinePenCallbacks\b/);
	});

	it("is re-exported from InlinePenRouter.ts as a type, once", () => {
		const line = 'export type { InlinePenCallbacks } from "./InlinePenCallbacks";';
		expect(routerSrc.split(line).length - 1).toBe(1);
	});

	it("takes types only and exports no value", () => {
		const imports = [...callbacksSrc.matchAll(/^import\s+(type\s+)?[^;]*;/gm)];
		for (const m of imports) expect(m[1], m[0]).toBeDefined();
		expect(Object.keys(callbacks)).toEqual([]);
	});

	it("keeps its member names, in order", () => {
		const start = callbacksSrc.indexOf("export interface InlinePenCallbacks {");
		const body = callbacksSrc.slice(start, callbacksSrc.indexOf("\n}\n", start));
		const names = [...body.matchAll(/^\t([A-Za-z]+)\??[(:]/gm)].map((m) => m[1]);
		expect(names).toEqual([...MEMBERS]);
	});
});
