/**
 * The pen router's listener install, the body of its constructor from the pointer
 * listeners onward, lives in InlinePenRouterBind.ts as four methods installed on
 * InlinePenRouter.prototype when InlinePenRouter.ts loads. Four things a type
 * check cannot see are held here, as the install tests of the other split files
 * hold them for theirs.
 *
 * LOAD ORDER. InlinePenRouter.ts imports the install function, and the bind file
 * imports one function back (the context-menu rule), so the two modules form a
 * cycle. Every other test imports InlinePenRouter.ts first. This file imports the
 * bind file first, so a cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the
 * descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when a
 * router was built.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * bind file declares each once.
 *
 * ONE DOOR AND THE ORDER. The bind file takes exactly the listed names from the
 * router. The constructor calls the four methods in the order the code ran when it
 * was inline, and a router built on a recording fake registers the same fifteen
 * listeners, on the same targets, in the same order. No other test registers or
 * fires the band claim, so this order is what notices a dropped band-root phase.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installInlinePenRouterBind } from "./InlinePenRouterBind";
import { InlinePenRouter } from "./InlinePenRouter";
import routerRaw from "./InlinePenRouter.ts?raw";
import bindRaw from "./InlinePenRouterBind.ts?raw";
import { fakeEl, installFakeWindow, recorder } from "../../test/routerHarness";

const MOVED = ["bindPointerListeners", "bindBandRoot", "bindStylusTouches", "bindContextMenu"] as const;

/** Every name the bind file takes from the router, and nothing else. */
const FROM_ROUTER = ["InlinePenRouter", "contextMenuSuppressed"];

/** Target, event type and capture flag of every listener a router registers while it is built, in order. */
const REGISTRATIONS = [
	"scroller pointerdown true",
	"scroller pointermove true",
	"scroller pointerrawupdate true",
	"scroller pointerup true",
	"scroller pointercancel true",
	"scroller gotpointercapture true",
	"scroller lostpointercapture true",
	"window blur false",
	"scroller pointerleave true",
	"viewRoot pointerdown true",
	"window touchstart true",
	"window touchmove true",
	"window touchend true",
	"window touchcancel true",
	"scroller contextmenu true",
];

const routerSrc = routerRaw.replace(/\r\n/g, "\n");
const bindSrc = bindRaw.replace(/\r\n/g, "\n");

let restoreWindow = () => {};
beforeAll(() => {
	restoreWindow = installFakeWindow();
});
afterAll(() => {
	restoreWindow();
});

/** A listener target that notes each registration under its own name. */
function recording<T extends object>(log: string[], name: string, target: T): T {
	const add = (type: string, _handler: unknown, options?: boolean | { capture?: boolean }) => {
		const capture = typeof options === "object" ? options.capture === true : options === true;
		log.push(`${name} ${type} ${capture}`);
	};
	return Object.assign(target, { addEventListener: add, removeEventListener: () => {} });
}

describe("listener install methods on the pen router prototype", () => {
	it("load with the bind file imported first", () => {
		expect(typeof installInlinePenRouterBind).toBe("function");
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

	it("each moved name is declared once in the bind file and not in the class", () => {
		const classStart = routerSrc.indexOf("export class InlinePenRouter {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = routerSrc.slice(classStart, routerSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = bindSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: InlinePenRouter\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in InlinePenRouterBind.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the router installs once, after the class closing brace", () => {
		const call = "installInlinePenRouterBind(InlinePenRouter.prototype);";
		expect(routerSrc.split(call).length - 1).toBe(1);
		const classStart = routerSrc.indexOf("export class InlinePenRouter {");
		const classEnd = routerSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(routerSrc.indexOf(call)).toBeGreaterThan(classEnd);
	});

	it("the bind file takes exactly the listed names from the router", () => {
		const imports = [...bindSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/InlinePenRouter";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_ROUTER].sort());
	});

	it("the constructor calls the four phases in the order they ran inline, band root with the scroller", () => {
		const calls = [
			"this.bindPointerListeners();",
			"this.bindBandRoot(scrollEl);",
			"this.bindStylusTouches();",
			"this.bindContextMenu();",
		];
		let at = routerSrc.indexOf("constructor(");
		expect(at).toBeGreaterThan(-1);
		for (const call of calls) {
			expect(routerSrc.split(call).length - 1, call).toBe(1);
			const next = routerSrc.indexOf(call);
			expect(next, call).toBeGreaterThan(at);
			at = next;
		}
	});

	it("a router built on a recording fake registers the fifteen listeners, on the same targets, in the same order", () => {
		const log: string[] = [];
		const viewRoot = recording(log, "viewRoot", {});
		const win = recording(log, "window", {});
		const scroller = recording(log, "scroller", fakeEl());
		Object.assign(scroller, {
			ownerDocument: { defaultView: win },
			closest: (selector: string) => (selector === ".markdown-source-view" ? viewRoot : null),
		});
		const router = new InlinePenRouter(
			scroller as unknown as HTMLElement,
			scroller as unknown as HTMLElement,
			recorder().cb
		);
		expect(log).toEqual(REGISTRATIONS);
		router.dispose();
	});
});
