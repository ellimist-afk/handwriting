/**
 * The delete and recycle handlers live in ink/RecycleOnDelete.ts and are
 * installed on HandwritingPlugin.prototype when main.ts loads. Two things a
 * type check cannot see are held here.
 *
 * LOAD ORDER. main.ts imports the install function and RECYCLE_GRACE_MS;
 * RecycleOnDelete.ts imports only types from main, so there is no cycle. This
 * file imports the recycle file first, and one cell loads main first in a
 * fresh module graph, so a value import added back from main fails here, in
 * either order, at load and not on a device.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the module augmentation declares it, and would only
 * fail when a file was deleted.
 */
import { describe, expect, it, vi } from "vitest";

import { RECYCLE_GRACE_MS, installRecycleOnDelete } from "./RecycleOnDelete";
import { HandwritingPlugin } from "../main";

const MOVED = ["onFileDeleted", "scheduleRecycle", "recycleIfStillGone", "stemTwinExists"] as const;

/** The field stemTwinExists reads, on a plugin built without its constructor. */
type BarePlugin = {
	app: { vault: { getFiles(): { path: string; extension: string }[] } };
	stemTwinExists(deletedPath: string): boolean;
};

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

describe("delete and recycle methods on the plugin prototype", () => {
	it("load with the recycle file imported first, and a moved method runs on a bare plugin", () => {
		expect(typeof installRecycleOnDelete).toBe("function");
		expect(RECYCLE_GRACE_MS).toBe(10_000);
		const plugin = Object.create(HandwritingPlugin.prototype) as BarePlugin;
		plugin.app = { vault: { getFiles: () => [{ path: "Notes/Kept.mdenc", extension: "mdenc" }] } };
		expect(plugin.stemTwinExists("Notes/Kept.md")).toBe(true);
		expect(plugin.stemTwinExists("Notes/Gone.md")).toBe(false);
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		expectInstalled(HandwritingPlugin.prototype);
	});

	it("load with main imported first in a fresh module graph, and the install is the same", async () => {
		vi.resetModules();
		const main = await import("../main");
		const moved = await import("./RecycleOnDelete");
		expect(typeof moved.installRecycleOnDelete).toBe("function");
		expect(main.HandwritingPlugin).not.toBe(HandwritingPlugin);
		expectInstalled(main.HandwritingPlugin.prototype);
	});
});
