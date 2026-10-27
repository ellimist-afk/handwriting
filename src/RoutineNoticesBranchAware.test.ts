/**
 * Part 2 of routine-toasts-diagnostics: the notices whose ROUTINE arm shares a
 * callsite with one that must keep showing (root, 2026-09-09, route (a)).
 *
 * Every suppression case here is PAIRED with the retained arm of the same
 * helper under the same switch state. That pairing is the point: a gate that
 * hid the whole callsite would pass a "success is quiet" assertion and fail
 * only the retained one, so the retained assertions are what make these cases
 * mean anything.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => ({ said: [] as string[], hidden: [] as string[] }));

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			messageEl = { isConnected: true };
			private msg: string;
			constructor(message: string) {
				this.msg = message;
				notices.said.push(message);
			}
			hide(): void {
				this.messageEl.isConnected = false;
				notices.hidden.push(this.msg);
			}
			setMessage(): void {}
		},
	};
});

// The note surface's strip, stood in for. The overlay builds it with an
// options bag whose `exec` is what every strip button runs; this keeps that
// `exec` so a cell can press a button, and answers every other call with
// nothing. The zoom controls beside it need a laid-out page, so they are not
// built.
const strip = vi.hoisted(() => ({ exec: null as null | ((id: string) => void) }));
vi.mock("./inline/MobileTools", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class StripStandIn {
		constructor(_host: unknown, opts: { exec(id: string): void }) {
			strip.exec = opts.exec;
			return new Proxy(this, {
				get: (target, prop) => (prop in target ? Reflect.get(target, prop) : () => undefined),
			});
		}
	}
	return { ...actual, MobileTools: StripStandIn, ensureNoteZoomControls: () => null };
});

import {
	type CutSelectionOutcome,
	copySelectionNotice,
	copySelectionNoticeIsRoutine,
	cutSelectionNotice,
	cutSelectionNoticeIsRoutine,
} from "./inline/InkOverlay";
import { setRoutineNoticesVisible } from "./diag/RoutineNotices";
import { mountOverlay } from "./inline/mountRig.test.util";
import { resetPenToolsForTest, setPenToolsMode } from "./inline/PenToolsMode";
import type { InkPreset } from "./ink/InkPresets";

describe("the copy sentence is classified by arm, and the text is unchanged", () => {
	it("calls the count routine and the no-op guidance not routine", () => {
		expect(copySelectionNoticeIsRoutine(3)).toBe(true);
		expect(copySelectionNoticeIsRoutine(0)).toBe(false);
	});

	it("still returns the exact sentences it always did", () => {
		expect(copySelectionNotice(3)).toBe("Handwriting: copied 3 stroke(s)");
		expect(copySelectionNotice(0)).toBe("Handwriting: lasso some ink first");
	});
});

describe("the cut sentence has THREE arms and only the first is routine", () => {
	it("classifies each arm", () => {
		expect(cutSelectionNoticeIsRoutine({ kind: "cut", count: 2 })).toBe(true);
		expect(cutSelectionNoticeIsRoutine({ kind: "empty" })).toBe(false);
		// The partial failure: ink copied but not removed. Never hidden.
		expect(cutSelectionNoticeIsRoutine({ kind: "unmatched", count: 2 })).toBe(false);
	});

	it("still returns the exact sentences it always did", () => {
		expect(cutSelectionNotice({ kind: "cut", count: 2 })).toBe("Handwriting: cut 2 stroke(s)");
		expect(cutSelectionNotice({ kind: "empty" })).toBe("Handwriting: lasso some ink first");
		expect(cutSelectionNotice({ kind: "unmatched", count: 2 })).toBe(
			"Handwriting: copied 2 stroke(s) but could not remove them - the lasso has been kept"
		);
	});
});

describe("the preset slot is shared, so a silent routine action must still CLEAR it", () => {
	beforeEach(() => {
		notices.said = [];
		notices.hidden = [];
		setRoutineNoticesVisible(false);
	});

	/** Drives the real preset actions rather than a copy of them. */
	async function presets() {
		const { installInkPresetActions } = await import("./ink/InkPresetHost");
		const mod = await import("./ink/InkPresets");
		let list: ReadonlyArray<InkPreset> = [
			{ tool: "pen", hex: "#112233", name: "blue", size: 1 },
		];
		mod.setInkPresets(list);
		installInkPresetActions({
			list: () => list,
			save: (next) => {
				list = [...next];
			},
		});
		return mod;
	}

	it("keeps the empty-slot sentence with the switch off, and stays quiet on a pickup", async () => {
		const mod = await presets();

		// RETAINED arm: an empty slot still reports, switch off.
		mod.applyInkPreset("pen", 3);
		expect(notices.said).toEqual(["Handwriting: pen preset 4 is empty."]);

		// ROUTINE arm: a successful pickup says nothing...
		notices.said = [];
		mod.applyInkPreset("pen", 0);
		expect(notices.said).toEqual([]);
	});

	it("shows the pickup with the switch on - the control for the case above", async () => {
		const mod = await presets();
		setRoutineNoticesVisible(true);
		mod.applyInkPreset("pen", 0);
		expect(notices.said).toHaveLength(1);
		expect(notices.said[0]).toContain("Handwriting: ");
	});

	it("PUTS DOWN a retained toast even though the routine one stays silent", async () => {
		// The case root asked for proof of. "preset 4 is empty." is retained and
		// on screen; a successful pickup is now silent. If the silent path
		// skipped the clear, that sentence would sit there describing the
		// PREVIOUS action, with nothing left to take it down.
		const mod = await presets();
		// `sayPreset` is module scope and outlives a single case, so measure the
		// TRANSITION rather than an absolute: put the retained toast up, reset
		// the recorders, then make the silent routine call.
		mod.applyInkPreset("pen", 3);
		expect(notices.said.at(-1)).toBe("Handwriting: pen preset 4 is empty.");
		notices.said = [];
		notices.hidden = [];

		mod.applyInkPreset("pen", 0);
		expect(notices.said).toEqual([]);
		expect(notices.hidden).toEqual(["Handwriting: pen preset 4 is empty."]);
	});

	it("STARRING is quiet with the switch off and shows with it on", async () => {
		const mod = await presets();
		mod.starInkPreset("pen");
		expect(notices.said).toEqual([]);

		notices.said = [];
		setRoutineNoticesVisible(true);
		mod.starInkPreset("pen");
		expect(notices.said).toHaveLength(1);
		expect(notices.said[0]).toContain("starred");
	});
});

describe("the note strip's copy and cut, run on a mounted overlay", () => {
	// The strip's copy and cut buttons on the note surface, pressed through the
	// strip's own `exec` on a real overlay mounted all the way. The two
	// selection actions are stood in for, so each press takes a chosen arm: the
	// subject is what the button does with the outcome, not the selection.
	beforeEach(() => {
		notices.said = [];
		strip.exec = null;
		setRoutineNoticesVisible(false);
	});

	function noteStrip(path: string) {
		resetPenToolsForTest();
		setPenToolsMode("show");
		const m = mountOverlay(path, { app: { commands: { executeCommandById: vi.fn() } } });
		const o = m.o as Record<string, unknown> & { ensurePenToolsInner(): void };
		// The rig stands `ensurePenTools` down; the strip is built by the real
		// method behind it.
		o.ensurePenToolsInner();
		const exec = strip.exec;
		const copied = { n: 0 };
		const cutOutcome: { value: CutSelectionOutcome } = { value: { kind: "empty" } };
		const copy = vi.fn(() => copied.n);
		const cut = vi.fn(() => cutOutcome.value);
		o.copySelectedInk = copy;
		o.cutSelectedInk = cut;
		return {
			exec(id: string) {
				expect(exec, "precondition: the note built its strip").not.toBeNull();
				exec!(id);
			},
			copied,
			cutOutcome,
			copy,
			cut,
			done() {
				m.destroy();
				resetPenToolsForTest();
			},
		};
	}

	it("never gates the copy or cut ACTION, only its sentence", () => {
		// copySelectedInk()/cutSelectedInk() perform the work and return the
		// outcome. Gating those calls would stop copy and cut working whenever
		// the switch was off - silent, and invisible to a toast assertion.
		const rig = noteStrip("routine-strip-action.md");
		try {
			rig.copied.n = 3;
			rig.exec("handwriting:copy-selected-ink");
			expect(rig.copy, "the strip's copy did not copy with routine notices off").toHaveBeenCalledTimes(1);
			rig.cutOutcome.value = { kind: "cut", count: 2 };
			rig.exec("handwriting:cut-selected-ink");
			expect(rig.cut, "the strip's cut did not cut with routine notices off").toHaveBeenCalledTimes(1);
		} finally {
			rig.done();
		}
	});

	it("gates each selection sentence branch-awarely, not wholesale", () => {
		const rig = noteStrip("routine-strip-sentence.md");
		try {
			// Switch off: the routine arms are quiet...
			rig.copied.n = 3;
			rig.exec("handwriting:copy-selected-ink");
			rig.cutOutcome.value = { kind: "cut", count: 2 };
			rig.exec("handwriting:cut-selected-ink");
			expect(notices.said, "a routine copy or cut spoke with routine notices off").toEqual([]);

			// ...and every retained arm still speaks.
			rig.copied.n = 0;
			rig.exec("handwriting:copy-selected-ink");
			expect(notices.said, "the strip's copy guidance was hidden with the routine notices").toEqual([
				"Handwriting: lasso some ink first",
			]);
			notices.said = [];
			rig.cutOutcome.value = { kind: "empty" };
			rig.exec("handwriting:cut-selected-ink");
			rig.cutOutcome.value = { kind: "unmatched", count: 2 };
			rig.exec("handwriting:cut-selected-ink");
			expect(notices.said, "the strip's cut guidance or its partial failure was hidden with the routine notices").toEqual([
				"Handwriting: lasso some ink first",
				"Handwriting: copied 2 stroke(s) but could not remove them - the lasso has been kept",
			]);

			// Switch on: the routine arms speak too - the control for the case above.
			notices.said = [];
			setRoutineNoticesVisible(true);
			rig.copied.n = 3;
			rig.exec("handwriting:copy-selected-ink");
			rig.cutOutcome.value = { kind: "cut", count: 2 };
			rig.exec("handwriting:cut-selected-ink");
			expect(notices.said, "a routine copy or cut stayed quiet with routine notices on").toEqual([
				"Handwriting: copied 3 stroke(s)",
				"Handwriting: cut 2 stroke(s)",
			]);
		} finally {
			rig.done();
		}
	});
});

describe("the main.ts callsites, pinned in source, for the two facts no executed case reaches", () => {
	// The note strip's half of these two facts runs above. main.ts's half -
	// the palette commands - is still read as text, and waits for its own pass
	// over the tests that read main.ts.
	// The command registrations live in commands/RegisterCommands.ts and RegisterExportCommands.ts, read here with main.ts.
	const MAIN = [
		import.meta.glob("./main.ts", { query: "?raw", import: "default", eager: true })["./main.ts"] as string,
		import.meta.glob("./commands/RegisterCommands.ts", { query: "?raw", import: "default", eager: true })[
			"./commands/RegisterCommands.ts"
		] as string,
		import.meta.glob("./commands/RegisterExportCommands.ts", { query: "?raw", import: "default", eager: true })[
			"./commands/RegisterExportCommands.ts"
		] as string,
	].join("\n");

	it("read main.ts", () => {
		expect(MAIN.length).toBeGreaterThan(1000);
	});

	it("never gates the copy or cut ACTION, only its sentence", () => {
		expect(MAIN).not.toContain("if (routineNoticesVisible()) new Notice(copySelectionNotice(");
		expect(MAIN).not.toContain("if (routineNoticesVisible()) new Notice(cutSelectionNotice(");
		expect(MAIN).toContain("const copied = surface.overlay.copySelectedInk();");
		expect(MAIN).toContain("const outcome = surface.overlay.cutSelectedInk();");
	});

	it("gates each selection sentence branch-awarely, not wholesale", () => {
		expect(MAIN).toContain("routineNoticesVisible() || !copySelectionNoticeIsRoutine(copied)");
		expect(MAIN).toContain("routineNoticesVisible() || !cutSelectionNoticeIsRoutine(outcome)");
	});
});
