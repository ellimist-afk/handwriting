/**
 * The note zoom controls (the zoom bar's buttons, the edge it steps aside on, and the registry of live bars)
 * live in NoteZoomControls.ts, and MobileTools.ts re-exports the names other files import, so every importer
 * keeps its import line. Three things a type check cannot see are held here.
 *
 * LOAD. This file imports the new module first. It must import no value from MobileTools.ts: the strip loads
 * it, and a value import added back would make a cycle that only works in one order. It takes only the
 * MobileToolsHost type, which is erased at build.
 *
 * ONE COPY. Each re-exported name must be the very same function or class from both files, not a second
 * definition that behaves alike, and the live registry must be the one the refresh-all function reads.
 *
 * BEHAVIOUR. A few calls through the re-export, so a name that came across empty or wired to the wrong body
 * fails here and not on a device.
 */
import { describe, expect, it } from "vitest";

import * as controls from "./NoteZoomControls";
import * as strip from "./MobileTools";
import controlsRaw from "./NoteZoomControls.ts?raw";

/** Exported by the new file and re-exported, under the same name, by MobileTools.ts. */
const MOVED = [
	"refreshNoteZoomControlsAll",
	"NoteZoomControls",
	"ensureNoteZoomControls",
	"destroyNoteZoomControls",
] as const;

const controlsSrc = controlsRaw.replace(/\r\n/g, "\n");

describe("MobileTools.ts re-exports the note zoom controls from NoteZoomControls.ts", () => {
	it("loads with the new file imported first, and it takes no value from the strip", () => {
		expect(typeof controls.NoteZoomControls).toBe("function");
		for (const line of controlsSrc.match(/^import .*$/gm) ?? []) {
			expect(line, line).not.toMatch(/^import \{(?! type )[^}]*\} from "\.\/MobileTools"/);
		}
	});

	it.each(MOVED)("%s is one copy, the same from both files", (name) => {
		const fromControls = (controls as Record<string, unknown>)[name];
		const fromStrip = (strip as Record<string, unknown>)[name];
		expect(fromControls).toBeDefined();
		expect(fromStrip).toBe(fromControls);
	});

	it("StepAside is exported, because the strip class uses it", () => {
		expect(typeof controls.StepAside).toBe("function");
	});

	it("destroyNoteZoomControls with nothing to destroy answers null", () => {
		expect(strip.destroyNoteZoomControls(null)).toBeNull();
	});

	it("destroyNoteZoomControls destroys the controls it is handed once and answers null", () => {
		let destroyed = 0;
		const fake = { destroy: () => destroyed++ } as unknown as controls.NoteZoomControls;
		expect(strip.destroyNoteZoomControls(fake)).toBeNull();
		expect(destroyed).toBe(1);
	});

	it("ensureNoteZoomControls keeps the controls it has and makes none without a container", () => {
		const host = {} as Parameters<typeof controls.ensureNoteZoomControls>[3];
		const parent = (): HTMLElement => {
			throw new Error("no parent should be asked for");
		};
		const have = { destroy: () => {} } as unknown as controls.NoteZoomControls;
		expect(strip.ensureNoteZoomControls(have, null, parent, host)).toBe(have);
		expect(strip.ensureNoteZoomControls(null, null, parent, host)).toBeNull();
	});

	it("penUp clears the inking state and steps the bar back in", () => {
		const sets: boolean[] = [];
		const bar = Object.create(strip.NoteZoomControls.prototype) as {
			inking: boolean;
			stepAside: { set(on: boolean): void };
			penUp(): void;
		};
		bar.inking = true;
		bar.stepAside = { set: (on) => sets.push(on) };
		bar.penUp();
		expect(bar.inking).toBe(false);
		expect(sets).toEqual([false]);
	});

	it("refreshNoteZoomControlsAll with no live bar does nothing", () => {
		expect(() => strip.refreshNoteZoomControlsAll()).not.toThrow();
	});
});
