/**
 * The pen router's pointer input lives in InlinePenRouterInput.ts and is
 * installed on InlinePenRouter.prototype when InlinePenRouter.ts loads. Four things
 * a type check cannot see are held here, as the install tests of the other split
 * files hold them for theirs.
 *
 * LOAD ORDER. InlinePenRouter.ts imports the install function, and the input file
 * imports values back (the logger, the style helpers, the live router set and the
 * guard flag), so the two modules form a cycle. Every other test imports
 * InlinePenRouter.ts first. This file imports the input file first, so a cycle
 * that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the
 * descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when that
 * input path ran on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * input file declares each once, so a half-finished move cannot pass with the
 * old copy still shadowing the new one.
 *
 * ONE DOOR. The input file names nothing of the router beyond the list below.
 */
import { describe, expect, it, vi } from "vitest";

import { installInlinePenRouterInput } from "./InlinePenRouterInput";
import { InlinePenRouter, guardEnabled, setPenGestureGuardEnabled } from "./InlinePenRouter";
import routerRaw from "./InlinePenRouter.ts?raw";
import inputRaw from "./InlinePenRouterInput.ts?raw";

const MOVED = [
	"pointerDown",
	"claimFingerInk",
	"cancelFingerInkForPinch",
	"commitFingerInkForPenPreemption",
	"traceHover",
	"pointerMove",
	"pointerRawUpdate",
	"feedBeforeSilentLift",
	"smoothed",
	"pointerUpOrCancel",
	"resumeEaseIfIdle",
	"endPenStroke",
	"retireAllContactsOnNativeEnd",
	"retireEndedFingerContact",
	"armEndBackstop",
	"disarmEndBackstop",
] as const;

/** Every name the input file takes from the router, and nothing else. */
const FROM_ROUTER = [
	"InlinePenRouter",
	"backstopMayEnd",
	"computedTouchActionNote",
	"csOf",
	"guardEnabled",
	"liveRouters",
	"tr",
];

const routerSrc = routerRaw.replace(/\r\n/g, "\n");
const inputSrc = inputRaw.replace(/\r\n/g, "\n");

/** A router with no host, as the other install tests build theirs: the prototype and the fields a method reads. */
function bareRouter(fields: Record<string, unknown>): InlinePenRouter {
	const router = Object.create(InlinePenRouter.prototype) as InlinePenRouter;
	for (const [name, value] of Object.entries(fields)) {
		Object.defineProperty(router, name, { value, writable: true, configurable: true });
	}
	return router;
}

describe("pointer input methods on the pen router prototype", () => {
	it("load with the input file imported first, and moved methods run on a bare router", () => {
		expect(typeof installInlinePenRouterInput).toBe("function");
		// smoothed: with no mouse trail the samples come back as the same array.
		const samples = [{ x: 1, y: 2 }] as unknown as Parameters<InlinePenRouter["smoothed"]>[0];
		const plain = bareRouter({ mouseStrokeTrail: null });
		expect(plain.smoothed(samples)).toBe(samples);
		// resumeEaseIfIdle: the setup makes the idle branch real. On a bare object activePenId is
		// undefined, which is not null, so without the fields below the cell would pass for the wrong reason.
		const onAllContactsLifted = vi.fn();
		const idle = bareRouter({
			activePenId: null,
			touchPos: new Map(),
			guardTouches: new Set(),
			swallowedTouches: new Set(),
			cb: { onAllContactsLifted },
		});
		idle.resumeEaseIfIdle();
		expect(onAllContactsLifted).toHaveBeenCalledTimes(1);
		Object.defineProperty(idle, "activePenId", { value: 1, writable: true, configurable: true });
		idle.resumeEaseIfIdle();
		expect(onAllContactsLifted).toHaveBeenCalledTimes(1);
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		for (const name of MOVED) {
			const d = Object.getOwnPropertyDescriptor(InlinePenRouter.prototype, name);
			expect(d, `${name} is not on the prototype`).toBeDefined();
			expect(typeof d!.value, name).toBe("function");
			expect(
				{ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable },
				name
			).toEqual({ writable: true, enumerable: false, configurable: true });
		}
	});

	it("each moved name is declared once in the input file and not in the class", () => {
		const classStart = routerSrc.indexOf("export class InlinePenRouter {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = routerSrc.slice(classStart, routerSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = inputSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: InlinePenRouter\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in InlinePenRouterInput.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the router installs once, after the class closing brace, as the last statement of the file", () => {
		const call = "installInlinePenRouterInput(InlinePenRouter.prototype);";
		expect(routerSrc.split(call).length - 1).toBe(1);
		const classStart = routerSrc.indexOf("export class InlinePenRouter {");
		const classEnd = routerSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(routerSrc.indexOf(call)).toBeGreaterThan(classEnd);
		expect(routerSrc.trimEnd().endsWith(call)).toBe(true);
	});

	it("the input file takes exactly the listed names from the router", () => {
		const imports = [...inputSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/InlinePenRouter";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_ROUTER].sort());
	});

	it("the guard flag is a live binding: the input file reads the router's current value", () => {
		expect(guardEnabled).toBe(true);
		setPenGestureGuardEnabled(false);
		try {
			expect(guardEnabled).toBe(false);
		} finally {
			setPenGestureGuardEnabled(true);
		}
		expect(guardEnabled).toBe(true);
	});
});
