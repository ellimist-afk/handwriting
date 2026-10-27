/**
 * The pen router's lifecycle trace and window delivery mirror live in
 * InlinePenRouterTrace.ts and InlinePenRouter.ts re-exports them, so every
 * importer keeps its import line. Four things a type check cannot see are held
 * here, in the way the install tests of the other split files hold theirs for a
 * prototype install.
 *
 * LOAD. This file imports the trace module first. That module takes only a type
 * from InlinePenRouter.ts, so the two form no cycle at run time, and the order
 * of the two imports cannot matter. A value import added back would make the
 * order matter, and the one-door cell below says so.
 *
 * ONE COPY. Each re-exported name must be the very same function or object from
 * both files, not a second definition that happens to behave alike. The four
 * registries the router class reads must be the very Set objects the mirror and
 * the clear read.
 *
 * NO BODY LEFT BEHIND. InlinePenRouter.ts holds no declaration of a moved name,
 * and the trace module holds exactly one of each.
 *
 * THE COUNTER. The ownership guard's suppressed-native count is written from
 * outside the trace module through one function, and it must show in the summary
 * line and reset with the trace clear.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as trace from "./InlinePenRouterTrace";
import * as router from "./InlinePenRouter";
import routerRaw from "./InlinePenRouter.ts?raw";
import traceRaw from "./InlinePenRouterTrace.ts?raw";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { fakeEl, harness, installFakeWindow, recorder } from "../../test/routerHarness";

/** Exported by the trace module and re-exported, under the same name, by InlinePenRouter.ts. */
const REEXPORTED = [
	"anyHandOnGlass",
	"captureInlinePenTrace",
	"clearInlinePenTrace",
	"computedTouchActionNote",
	"csOf",
	"formatInlinePenTrace",
	"liveRouters",
	"summarizeAcquisitions",
	"tr",
	"traceSampleBudget",
	"traceStripClick",
	"traceSurface",
] as const;

/** Exported by the trace module for the router class's own code, and never re-exported from InlinePenRouter.ts. */
const SHARED = [
	"armWindowMirror",
	"disarmWindowMirror",
	"liveChromeDescribers",
	"liveScrollers",
	"liveSuppressedTypes",
	"noteSuppressedNative",
] as const;

/** Types exported by the trace module and re-exported by InlinePenRouter.ts. */
const TYPES = ["TraceCapture", "TraceEntry", "TraceEnv", "TraceSample"] as const;

const routerSrc = routerRaw.replace(/\r\n/g, "\n");
const traceSrc = traceRaw.replace(/\r\n/g, "\n");

function declarations(source: string, name: string): number {
	return source.match(new RegExp(`^(?:export )?(?:function|const|let|class|interface|type) ${name}\\b`, "gm"))?.length ?? 0;
}

let restoreWindow = () => {};
beforeAll(() => {
	restoreWindow = installFakeWindow();
});
afterAll(() => {
	setDiagnosticsEnabled(false);
	restoreWindow();
});

describe("the pen router's trace lives in InlinePenRouterTrace.ts", () => {
	it("loads with the trace module imported first", () => {
		expect(typeof trace.tr).toBe("function");
		expect(typeof router.InlinePenRouter).toBe("function");
	});

	it("is re-exported from InlinePenRouter.ts as the same function or object, name by name", () => {
		const fromRouter = router as unknown as Record<string, unknown>;
		const fromTrace = trace as unknown as Record<string, unknown>;
		expect(Object.keys(fromTrace).sort()).toEqual([...REEXPORTED, ...SHARED].sort());
		for (const name of REEXPORTED) {
			expect(name in fromRouter, `${name} is not exported by InlinePenRouter.ts`).toBe(true);
			expect(fromRouter[name], `${name} is not the same value from both files`).toBe(fromTrace[name]);
		}
	});

	it("keeps the six names for the class out of InlinePenRouter.ts's exports", () => {
		const fromRouter = router as unknown as Record<string, unknown>;
		for (const name of SHARED) expect(name in fromRouter, `${name} must stay out of InlinePenRouter.ts's exports`).toBe(false);
	});

	it("re-exports the four types from the trace module", () => {
		const typeExport = routerSrc.match(/^export type \{([^}]*)\} from "\.\/InlinePenRouterTrace";/m);
		expect(typeExport?.[1]?.split(",").map((s) => s.trim()).sort()).toEqual([...TYPES]);
	});

	it("gives the router class the registries the mirror and the clear read: the same Set objects", () => {
		const scrollersBefore = trace.liveScrollers.size;
		const describersBefore = trace.liveChromeDescribers.size;
		const typesBefore = trace.liveSuppressedTypes.size;
		const routersBefore = router.liveRouters.size;
		expect(router.liveRouters).toBe(trace.liveRouters);
		const scroller = fakeEl();
		const built = new router.InlinePenRouter(
			scroller as unknown as HTMLElement,
			scroller as unknown as HTMLElement,
			{ ...recorder().cb, describeChrome: () => "chrome" }
		);
		expect(trace.liveRouters.size).toBe(routersBefore + 1);
		expect(trace.liveRouters.has(built)).toBe(true);
		expect(trace.liveScrollers.size).toBe(scrollersBefore + 1);
		expect(trace.liveScrollers.has(scroller as unknown as HTMLElement)).toBe(true);
		expect(trace.liveChromeDescribers.size).toBe(describersBefore + 1);
		expect(trace.liveSuppressedTypes.size).toBe(typesBefore + 1);
		expect(trace.liveSuppressedTypes.has(built["suppressedTraced"])).toBe(true);
		built.dispose();
		expect(trace.liveRouters.has(built)).toBe(false);
	});
});

describe("no declaration is left behind in InlinePenRouter.ts", () => {
	it("declares each moved name once in the trace module and never in InlinePenRouter.ts", () => {
		for (const name of [...REEXPORTED, ...SHARED, ...TYPES]) {
			expect(declarations(traceSrc, name), `${name} in InlinePenRouterTrace.ts`).toBe(1);
			expect(declarations(routerSrc, name), `${name} in InlinePenRouter.ts`).toBe(0);
		}
	});

	it("imports the trace module from InlinePenRouter.ts and re-exports its values there", () => {
		expect(routerSrc).toMatch(/^import \{[^}]*\} from "\.\/InlinePenRouterTrace";/m);
		const valueExport = routerSrc.match(/^export \{([^}]*)\} from "\.\/InlinePenRouterTrace";/m);
		expect(valueExport?.[1]?.split(",").map((s) => s.trim()).filter(Boolean).sort()).toEqual([...REEXPORTED].sort());
	});

	it("takes only a type from InlinePenRouter.ts, so no value import comes back", () => {
		const imports = [...traceSrc.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"\.\/InlinePenRouter";/gm)];
		expect(imports.length).toBeGreaterThan(0);
		for (const m of imports) expect(m[1], m[0]).toBeDefined();
		expect(traceSrc).not.toMatch(/^export [^;]*from\s+"\.\/InlinePenRouter";/m);
	});
});

describe("the suppressed-native count", () => {
	it("shows in the summary line when noteSuppressedNative() is called, and resets with the trace clear", () => {
		setDiagnosticsEnabled(true);
		router.clearInlinePenTrace();
		router.tr("pointerdown", null, "first");
		expect(router.formatInlinePenTrace()).toContain("0 native event(s) suppressed by the ownership guard");
		trace.noteSuppressedNative();
		trace.noteSuppressedNative();
		expect(router.formatInlinePenTrace()).toContain("2 native event(s) suppressed by the ownership guard");
		router.clearInlinePenTrace();
		router.tr("pointerdown", null, "second");
		expect(router.formatInlinePenTrace()).toContain("0 native event(s) suppressed by the ownership guard");
	});

	it("is written by the router's own guard through the function, one event at a time", () => {
		setDiagnosticsEnabled(true);
		router.clearInlinePenTrace();
		const h = harness();
		h.router["traceSuppressed"]("click");
		h.router["traceSuppressed"]("mousedown");
		expect(router.formatInlinePenTrace()).toContain("2 native event(s) suppressed by the ownership guard");
		expect(routerSrc).toContain("noteSuppressedNative();");
		expect(routerSrc).not.toContain("suppressedNative++");
		h.router.dispose();
		router.clearInlinePenTrace();
	});
});
