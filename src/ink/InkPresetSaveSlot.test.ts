/**
 * Audit low #151: "Save current pen as preset N" writes slot N, not the last
 * slot. Driven through the real command table, the real action hook and the
 * real host, with only the store and the Notice stood in.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => ({ said: [] as string[] }));

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			messageEl = { isConnected: true };
			constructor(message: string) {
				notices.said.push(message);
			}
			hide(): void {
				this.messageEl.isConnected = false;
			}
			setMessage(): void {}
		},
	};
});

import { setRoutineNoticesVisible } from "../diag/RoutineNotices";
import { registerInkPresetCommands } from "./InkPresetCommands";
import { installInkPresetActions, livePreset } from "./InkPresetHost";
import { inkPresetsFor, setInkPresets, starInkPreset, type InkPreset } from "./InkPresets";

const mk = (hex: string): InkPreset => ({ tool: "pen", hex, name: "x", size: 1 });
const FOUR = [mk("#111111"), mk("#222222"), mk("#333333"), mk("#444444")];

let saved: ReadonlyArray<InkPreset> = [];
const run = (id: string): void => {
	const cmds: Array<{ id: string; callback: () => void }> = [];
	registerInkPresetCommands({ addCommand: (c) => void cmds.push(c) });
	const cmd = cmds.find((c) => c.id === id);
	if (!cmd) throw new Error(`no command ${id}`);
	cmd.callback();
};
const load = (list: InkPreset[]): void => {
	saved = list;
	setInkPresets(list);
	installInkPresetActions({
		list: () => saved,
		save: (next) => {
			saved = [...next];
		},
	});
};
const pens = (): string[] => inkPresetsFor("pen").map((p) => p.hex);

describe("save current pen as preset N writes slot N (audit 151)", () => {
	beforeEach(() => {
		notices.said = [];
		setRoutineNoticesVisible(true);
	});

	it("with four saved, save as 2 replaces slot 2 and leaves 1, 3 and 4", () => {
		load([...FOUR]);
		const live = livePreset("pen").hex;
		run("ink-preset-save-pen-2");
		expect(pens()).toEqual(["#111111", live, "#333333", "#444444"]);
		expect(saved.map((p) => p.hex)).toEqual(pens());
	});

	it("with two saved, save as 4 appends as slot 3 and the notice says 3", () => {
		load([mk("#111111"), mk("#222222")]);
		const live = livePreset("pen").hex;
		run("ink-preset-save-pen-4");
		expect(pens()).toEqual(["#111111", "#222222", live]);
		expect(notices.said.at(-1)).toContain("Pen preset 3");
	});

	it("with two saved, save as 2 replaces slot 2 and the notice says 2", () => {
		load([mk("#111111"), mk("#222222")]);
		const live = livePreset("pen").hex;
		run("ink-preset-save-pen-2");
		expect(pens()).toEqual(["#111111", live]);
		expect(notices.said.at(-1)).toContain("Pen preset 2");
	});

	it("the chip's star, which names no slot, still replaces the last when full", () => {
		load([...FOUR]);
		const live = livePreset("pen").hex;
		starInkPreset("pen");
		expect(pens()).toEqual(["#111111", "#222222", "#333333", live]);
	});
});
