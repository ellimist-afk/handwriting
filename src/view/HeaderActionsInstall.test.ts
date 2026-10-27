/**
 * The header action and canvas choice methods live in view/HeaderActions.ts
 * and are installed on HandwritingPlugin.prototype when main.ts loads. Two
 * things a type check cannot see are held here.
 *
 * LOAD ORDER. main.ts imports the install function; HeaderActions.ts imports
 * only types from main, so there is no cycle. This file imports the header
 * actions file first, and one cell loads main first in a fresh module graph,
 * so a value import added back from main fails here, in either order, at load
 * and not on a device.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the module augmentation declares it, and would only
 * fail when the settings tab, the file menu or the command called it.
 */
import { describe, expect, it, vi } from "vitest";

import { installHeaderActions } from "./HeaderActions";
import { HandwritingPlugin } from "../main";

const MOVED = ["refreshHeaderActions", "registerHeaderActions", "applyCanvasChoice"] as const;

/** The one field refreshHeaderActions reads, on a plugin built without its constructor. */
type BarePlugin = { headerActionRefresh: (() => void) | null; refreshHeaderActions(): void };

function expectInstalled(proto: object): void {
	for (const name of MOVED) {
		const d = Object.getOwnPropertyDescriptor(proto, name);
		expect(d, `${name} is not on the prototype`).toBeDefined();
		expect(typeof d!.value, name).toBe("function");
		expect(
			{ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable },
			name
		).toEqual({ writable: true, enumerable: false, configurable: true });
	}
}

describe("header action methods on the plugin prototype", () => {
	it("load with the header actions file imported first, and a moved method runs on a bare plugin", () => {
		expect(typeof installHeaderActions).toBe("function");
		const plugin = Object.create(HandwritingPlugin.prototype) as BarePlugin;
		let refreshed = 0;
		plugin.headerActionRefresh = null;
		plugin.refreshHeaderActions();
		plugin.headerActionRefresh = () => { refreshed++; };
		plugin.refreshHeaderActions();
		expect(refreshed).toBe(1);
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		expectInstalled(HandwritingPlugin.prototype);
	});

	it("load with main imported first in a fresh module graph, and the install is the same", async () => {
		vi.resetModules();
		const main = await import("../main");
		const moved = await import("./HeaderActions");
		expect(typeof moved.installHeaderActions).toBe("function");
		expect(main.HandwritingPlugin).not.toBe(HandwritingPlugin);
		expectInstalled(main.HandwritingPlugin.prototype);
	});
});
