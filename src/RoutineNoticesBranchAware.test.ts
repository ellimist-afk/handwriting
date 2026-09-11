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

import {
	copySelectionNotice,
	copySelectionNoticeIsRoutine,
	cutSelectionNotice,
	cutSelectionNoticeIsRoutine,
} from "./inline/InkOverlay";
import { setRoutineNoticesVisible } from "./diag/RoutineNotices";
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

describe("the callsites, pinned in source, for the two facts no executed case reaches", () => {
	const MAIN = import.meta.glob("./main.ts", { query: "?raw", import: "default", eager: true })[
		"./main.ts"
	] as string;
	const OVERLAY = import.meta.glob("./inline/InkOverlay.ts", {
		query: "?raw",
		import: "default",
		eager: true,
	})["./inline/InkOverlay.ts"] as string;

	it("read both files", () => {
		expect(MAIN.length).toBeGreaterThan(1000);
		expect(OVERLAY.length).toBeGreaterThan(1000);
	});

	it("never gates the copy or cut ACTION, only its sentence", () => {
		// copySelectedInk()/cutSelectedInk() perform the work and return the
		// outcome. Gating those calls would stop copy and cut working whenever
		// the switch was off - silent, and invisible to a toast assertion.
		expect(MAIN).not.toContain("if (routineNoticesVisible()) new Notice(copySelectionNotice(");
		expect(MAIN).not.toContain("if (routineNoticesVisible()) new Notice(cutSelectionNotice(");
		expect(OVERLAY).not.toContain("if (routineNoticesVisible()) new Notice(copySelectionNotice(");
		expect(MAIN).toContain("const copied = surface.overlay.copySelectedInk();");
		expect(MAIN).toContain("const outcome = surface.overlay.cutSelectedInk();");
		expect(OVERLAY).toContain("const copied = this.copySelectedInk();");
	});

	it("gates each selection sentence branch-awarely, not wholesale", () => {
		expect(MAIN).toContain("routineNoticesVisible() || !copySelectionNoticeIsRoutine(copied)");
		expect(MAIN).toContain("routineNoticesVisible() || !cutSelectionNoticeIsRoutine(outcome)");
		expect(OVERLAY).toContain("routineNoticesVisible() || !copySelectionNoticeIsRoutine(copied)");
		expect(OVERLAY).toContain("routineNoticesVisible() || !cutSelectionNoticeIsRoutine(outcome)");
	});
});
