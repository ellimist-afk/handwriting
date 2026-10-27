/**
 * The stroke session state machine lives in SlidesStrokeSession.ts and
 * SlidesInkSurface.ts re-exports it, so every importer keeps its import line.
 * Four things a type check cannot see are held here.
 *
 * LOAD. SlidesStrokeSession.ts is imported first and alone, so a dependency that
 * only resolves once the surface file has loaded fails here, at load. The new
 * file has no import at all, and a test below holds it to that.
 *
 * ONE COPY. Each moved value must be the very same function, constant or object
 * from both files, not a second definition that happens to behave alike. The idle
 * session is compared by identity: the surface class assigns it and the reducer
 * returns it, and two copies would split those two uses.
 *
 * THE LITERALS. The surface tests compare the hold window and the silence window
 * through the constants, so changing both together would pass them. The numbers
 * are pinned here on the new module.
 *
 * NO BODY LEFT BEHIND. The surface file holds no declaration of a moved name, and
 * the new file holds exactly one of each, so a half-finished move cannot pass
 * with the old copy still shadowing the new one.
 */
import { describe, expect, it } from "vitest";

import { codeOnly } from "../CodeOnly";
import * as session from "./SlidesStrokeSession";
import * as surface from "./SlidesInkSurface";
import surfaceRaw from "./SlidesInkSurface.ts?raw";
import sessionRaw from "./SlidesStrokeSession.ts?raw";

const MOVED_VALUES = [
	"STROKE_HOLD_MS",
	"silentLift",
	"SILENT_LIFT_QUIET_MS",
	"IDLE_SESSION",
	"strokeSessionReducer",
] as const;

const MOVED_TYPES = ["StrokeEndReason", "StrokeSession", "StrokeSessionEvent", "StrokeSessionStep"] as const;

/**
 * A module specifier naming SlidesInkSurface.ts, in any import form: side-effect, named,
 * namespace, type, re-export, dynamic or require, with or without the .ts suffix.
 * Run on text with the comments blanked, so prose that mentions the file is not a hit.
 */
const NAMES_SURFACE = /["'`](?:\.\/|\.\.\/slides\/)SlidesInkSurface(?:\.ts)?["'`]/;

/** Any way the new file could pull something in: a static import, a dynamic import or a require. */
const PULLS_IN = /^\s*import\b|\bimport\s*\(|\brequire\s*\(|\bfrom\s*["'`]/m;

function declarations(source: string, name: string): number {
	const text = source.replace(/\r\n/g, "\n");
	return text.match(new RegExp(`^(?:export )?(?:function|const|interface|type) ${name}\\b`, "gm"))?.length ?? 0;
}

describe("the stroke session lives in SlidesStrokeSession.ts", () => {
	it("holds the two windows at 300 ms on the new module", () => {
		expect(session.STROKE_HOLD_MS).toBe(300);
		expect(session.SILENT_LIFT_QUIET_MS).toBe(300);
	});

	it("reads the hover signature from pressure and the two contact bits only", () => {
		expect(session.silentLift(0, 0)).toBe(true);
		expect(session.silentLift(0, 2)).toBe(true);
		expect(session.silentLift(0, 1)).toBe(false);
		expect(session.silentLift(0, 32)).toBe(false);
		expect(session.silentLift(0.4, 0)).toBe(false);
	});

	it("loads with the new file imported first, and runs one real reducer call per event kind", () => {
		const reduce = session.strokeSessionReducer;
		const idle = session.IDLE_SESSION;

		const down = reduce(idle, { kind: "down", pointerId: 1, t: 0, captured: true });
		expect(down.begin).toBe(true);
		expect(down.sample).toBe(true);
		expect(down.state).toEqual({
			phase: "drawing",
			pointerId: 1,
			captured: true,
			samples: 1,
			holdSince: null,
			holdReason: null,
		});
		expect(reduce(down.state, { kind: "down", pointerId: 2, t: 1, captured: true }).begin).toBe(false);

		const move = reduce(down.state, { kind: "move", pointerId: 1, t: 5 });
		expect(move.sample).toBe(true);
		expect(move.state.samples).toBe(2);

		const up = reduce(down.state, { kind: "up", pointerId: 1, t: 10 });
		expect(up.end).toBe("up");
		expect(up.state).toBe(idle);

		const cancel = reduce(down.state, { kind: "cancel", pointerId: 1, t: 10 });
		expect(cancel.end).toBeNull();
		expect(cancel.state).toMatchObject({ captured: false, holdSince: 10, holdReason: "cancel" });

		const lost = reduce(down.state, { kind: "lost-capture", pointerId: 1, t: 10 });
		expect(lost.end).toBeNull();
		expect(lost.state).toMatchObject({ captured: false, holdSince: 10, holdReason: "lost-capture" });

		const got = reduce(lost.state, { kind: "got-capture", pointerId: 1, t: 11 });
		expect(got.end).toBeNull();
		expect(got.state).toMatchObject({ captured: true, holdSince: 10, holdReason: "lost-capture" });

		const leave = reduce(down.state, { kind: "leave", pointerId: 1, t: 10 });
		expect(leave.end).toBe("leave");
		expect(leave.state).toBe(idle);

		const silent = reduce(down.state, { kind: "silent-lift", pointerId: 1, t: 10 });
		expect(silent.end).toBe("silent-lift");
		expect(silent.state).toBe(idle);

		const change = reduce(down.state, { kind: "slide-change", t: 10 });
		expect(change.end).toBe("slide-change");
		expect(change.state).toBe(idle);
		expect(reduce(idle, { kind: "slide-change", t: 10 }).end).toBeNull();

		expect(reduce(cancel.state, { kind: "tick", t: 10 + session.STROKE_HOLD_MS - 1 }).end).toBeNull();
		const tick = reduce(cancel.state, { kind: "tick", t: 10 + session.STROKE_HOLD_MS });
		expect(tick.end).toBe("cancel");
		expect(tick.state).toBe(idle);
	});

	it("is re-exported from the surface file as the same value, name by name", () => {
		const fromSurface = surface as unknown as Record<string, unknown>;
		const fromSession = session as unknown as Record<string, unknown>;
		for (const name of MOVED_VALUES) {
			expect(fromSession[name], `${name} is not exported by SlidesStrokeSession.ts`).toBeDefined();
			expect(fromSurface[name], `${name} is not the same value from both files`).toBe(fromSession[name]);
		}
		expect(surface.IDLE_SESSION).toBe(session.IDLE_SESSION);
	});

	it("keeps the moved types importable from the surface file", () => {
		const live: surface.StrokeSession = session.strokeSessionReducer(session.IDLE_SESSION, {
			kind: "down",
			pointerId: 1,
			t: 0,
			captured: true,
		}).state;
		const event: surface.StrokeSessionEvent = { kind: "tick", t: 0 };
		const step: surface.StrokeSessionStep = surface.strokeSessionReducer(live, event);
		const reason: surface.StrokeEndReason | null = step.end;
		const same: session.StrokeSession = step.state;
		expect(same.phase).toBe("drawing");
		expect(reason).toBeNull();
		expect(MOVED_TYPES).toHaveLength(4);
	});
});

describe("no declaration is left behind in SlidesInkSurface.ts", () => {
	it("declares each moved name once in the new file and never in the surface file", () => {
		for (const name of [...MOVED_VALUES, ...MOVED_TYPES]) {
			expect(declarations(sessionRaw, name), `${name} in SlidesStrokeSession.ts`).toBe(1);
			expect(declarations(surfaceRaw, name), `${name} in SlidesInkSurface.ts`).toBe(0);
		}
	});

	it("matches a name exactly, not as the start of a longer one", () => {
		const text = "export interface StrokeSessionStep {\n}\nexport type StrokeSessionEvent =\n";
		expect(declarations(text, "StrokeSession")).toBe(0);
		expect(declarations(text, "StrokeSessionStep")).toBe(1);
		expect(declarations(text, "StrokeSessionEvent")).toBe(1);
	});

	it("re-exports by name from the new file, never with a star", () => {
		const surfaceText = codeOnly(surfaceRaw.replace(/\r\n/g, "\n"));
		expect(surfaceText).toMatch(/^export \{[^}]*\} from "\.\/SlidesStrokeSession";/m);
		expect(surfaceText).toMatch(/^export type \{[^}]*\} from "\.\/SlidesStrokeSession";/m);
		expect(surfaceText).not.toMatch(/export\s*\*\s*from\s*["']\.\/SlidesStrokeSession/);
	});

	it("keeps the contact the surface class remembers on the surface side", () => {
		expect(declarations(surfaceRaw, "RestedContact")).toBe(1);
		expect(declarations(sessionRaw, "RestedContact")).toBe(0);
	});
});

describe("SlidesStrokeSession.ts depends on nothing", () => {
	it("has no import in any form, and names the surface file in none", () => {
		const code = codeOnly(sessionRaw);
		expect(PULLS_IN.test(code), "SlidesStrokeSession.ts pulls something in").toBe(false);
		expect(NAMES_SURFACE.test(code), "SlidesStrokeSession.ts names SlidesInkSurface").toBe(false);
	});

	it("sees every import form that names the surface file, and not a comment", () => {
		const forms = [
			'import "./SlidesInkSurface";',
			'import { silentLift } from "./SlidesInkSurface";',
			'import {\n\tsilentLift,\n} from "./SlidesInkSurface";',
			'import * as surface from "./SlidesInkSurface";',
			'import type { StrokeSession } from "./SlidesInkSurface";',
			'import surface from "./SlidesInkSurface.ts";',
			'export { silentLift } from "./SlidesInkSurface";',
			'export * from "./SlidesInkSurface";',
			'const surface = await import("./SlidesInkSurface");',
			"const surface = require('./SlidesInkSurface');",
			'import { silentLift } from "../slides/SlidesInkSurface";',
		];
		for (const form of forms) expect(NAMES_SURFACE.test(codeOnly(form)), form).toBe(true);
		expect(NAMES_SURFACE.test(codeOnly('// import "./SlidesInkSurface";'))).toBe(false);
		expect(NAMES_SURFACE.test(codeOnly('/* from "./SlidesInkSurface" */ const x = 1;'))).toBe(false);
	});

	it("sees every way of pulling a module in, and not a comment", () => {
		const forms = [
			'import "./Other";',
			'import { a } from "./Other";',
			'import type { A } from "../ink/Stroke";',
			'export { a } from "./Other";',
			'const m = await import("./Other");',
			"const m = require('./Other');",
		];
		for (const form of forms) expect(PULLS_IN.test(codeOnly(form)), form).toBe(true);
		expect(PULLS_IN.test(codeOnly('// import { a } from "./Other";'))).toBe(false);
		expect(PULLS_IN.test(codeOnly("export const A = 1;\nexport function f(): number {\n\treturn 2;\n}\n"))).toBe(false);
	});
});
