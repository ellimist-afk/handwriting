/**
 * The pen router's stroke end (finishing a live stroke the way a lift would, and
 * abandoning one when the surface switches) lives in InlinePenRouterEnd.ts and is
 * installed on InlinePenRouter.prototype when InlinePenRouter.ts loads. Four
 * things a type check cannot see are held here, as the install tests of the other
 * split files hold them for theirs.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the
 * descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when a
 * window blur or a note switch ran on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares neither name, and the stroke end
 * file declares each once.
 *
 * THE ORDER. The router installs the stroke end once, after the class, and
 * before the input install, which stays the last statement.
 *
 * ONE DOOR. The stroke end file names nothing of the router at run time.
 */
import { describe, expect, it } from "vitest";

import { installInlinePenRouterEnd } from "./InlinePenRouterEnd";
import { InlinePenRouter } from "./InlinePenRouter";
import routerRaw from "./InlinePenRouter.ts?raw";
import endRaw from "./InlinePenRouterEnd.ts?raw";

const MOVED = ["finishActiveStroke", "abandonActiveStroke"] as const;

const routerSrc = routerRaw.replace(/\r\n/g, "\n");
const endSrc = endRaw.replace(/\r\n/g, "\n");

/** A router with no host, as the other install tests build theirs: the prototype and the fields a method reads. */
function bareRouter(fields: Record<string, unknown>): InlinePenRouter {
	const router = Object.create(InlinePenRouter.prototype) as InlinePenRouter;
	for (const [name, value] of Object.entries(fields)) {
		Object.defineProperty(router, name, { value, writable: true, configurable: true, enumerable: true });
	}
	return router;
}

/** Every term of the abandon's live-gesture test, at rest. */
function idleFields(): Record<string, unknown> {
	return {
		activePenId: null,
		ownershipFn: null,
		ownershipDisarmTimer: null,
		ownershipTailUntil: 0,
		flingRaf: 0,
		gesturePanned: false,
		touchesAtStrokeStart: new Set<number>(),
		touchPos: new Map<number, unknown>(),
		liveTouchIds: new Set<number>(),
		guardTouches: new Set<number>(),
	};
}

describe("stroke end methods on the pen router prototype", () => {
	it("load with the stroke end file imported first", () => {
		expect(typeof installInlinePenRouterEnd).toBe("function");
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

	it("each moved name is declared once in the stroke end file and not in the class", () => {
		const classStart = routerSrc.indexOf("export class InlinePenRouter {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = routerSrc.slice(classStart, routerSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = endSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: InlinePenRouter\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in InlinePenRouterEnd.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the router installs once, after the class closing brace and directly before the input install", () => {
		const call = "installInlinePenRouterEnd(InlinePenRouter.prototype);";
		const input = "installInlinePenRouterInput(InlinePenRouter.prototype);";
		expect(routerSrc.split(call).length - 1).toBe(1);
		const classStart = routerSrc.indexOf("export class InlinePenRouter {");
		const classEnd = routerSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(routerSrc.indexOf(call)).toBeGreaterThan(classEnd);
		expect(routerSrc).toContain(`${call}\n${input}`);
	});

	it("the stroke end file takes only a type from the router", () => {
		const imports = [...endSrc.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"\.\/InlinePenRouter";/gm)];
		expect(imports.length).toBe(1);
		expect(imports[0]![1]).toBeDefined();
		expect(endSrc).not.toMatch(/^export [^;]*from\s+"\.\/InlinePenRouter";/m);
	});

	it("abandonActiveStroke with nothing live is false and changes no field", () => {
		const router = bareRouter(idleFields());
		const before = Object.entries(router).map(([k, v]) => [k, v instanceof Set || v instanceof Map ? v.size : v]);
		expect(router.abandonActiveStroke()).toBe(false);
		const after = Object.entries(router).map(([k, v]) => [k, v instanceof Set || v instanceof Map ? v.size : v]);
		expect(after).toEqual(before);
	});

	it("finishActiveStroke with no pen down is false", () => {
		expect(bareRouter({ activePenId: null }).finishActiveStroke()).toBe(false);
		expect(bareRouter({ activePenId: null }).finishActiveStroke({ preserveMouse: true })).toBe(false);
	});
});
