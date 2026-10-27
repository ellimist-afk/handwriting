/**
 * The page identity methods live in persistence/PageIdentity.ts and are
 * installed on HandwritingPlugin.prototype when main.ts loads. Two things a
 * type check cannot see are held here.
 *
 * LOAD ORDER. main.ts imports the install function; PageIdentity.ts imports
 * only types from main, so there is no cycle. This file imports the identity
 * file first, and one cell loads main first in a fresh module graph, so a
 * value import added back from main fails here, in either order, at load and
 * not on a device.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the module augmentation declares it, and would only
 * fail when that page id path ran.
 */
import { describe, expect, it, vi } from "vitest";

import { installPageIdentity } from "./PageIdentity";
import { HandwritingPlugin } from "../main";

const MOVED = [
	"buildPageIdIndex",
	"checkPageIdentity",
	"declaimLater",
	"followEditedId",
	"declaimNow",
	"resolveIdentityCollision",
	"recheckCollision",
	"findOtherCarrier",
	"resolveDuplicate",
	"persistOwners",
	"recentPageIdFor",
	"reportSplitInk",
	"noteNamesForPages",
	"warnUnusablePageId",
	"installId",
	"notePageId",
	"claimNotePageId",
] as const;

/** The app surface findOtherCarrier and recentPageIdFor read, on a plugin built without its constructor. */
type BarePlugin = {
	app: {
		vault: { getMarkdownFiles(): { path: string }[] };
		metadataCache: { getCache(path: string): { frontmatter?: Record<string, unknown> } | null };
	};
	findOtherCarrier(id: string, exceptPath: string): string | null;
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

describe("page identity methods on the plugin prototype", () => {
	it("load with the identity file imported first, and a moved method runs on a bare plugin", () => {
		expect(typeof installPageIdentity).toBe("function");
		const plugin = Object.create(HandwritingPlugin.prototype) as BarePlugin;
		const ids: Record<string, unknown> = {
			"Notes/Original.md": "page-0123456789abcdef",
			"Notes/Copy.md": "page-0123456789abcdef",
			"Notes/Other.md": "page-fedcba9876543210",
			"Notes/Unsafe.md": "../escape",
		};
		plugin.app = {
			vault: { getMarkdownFiles: () => Object.keys(ids).map((path) => ({ path })) },
			metadataCache: { getCache: (path) => ({ frontmatter: { "handwriting-page-id": ids[path] } }) },
		};
		expect(plugin.findOtherCarrier("page-0123456789abcdef", "Notes/Original.md")).toBe("Notes/Copy.md");
		expect(plugin.findOtherCarrier("page-fedcba9876543210", "Notes/Other.md")).toBeNull();
		expect(plugin.findOtherCarrier("../escape", "Notes/Original.md")).toBeNull();
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		expectInstalled(HandwritingPlugin.prototype);
	});

	it("load with main imported first in a fresh module graph, and the install is the same", async () => {
		vi.resetModules();
		const main = await import("../main");
		const moved = await import("./PageIdentity");
		expect(typeof moved.installPageIdentity).toBe("function");
		expect(main.HandwritingPlugin).not.toBe(HandwritingPlugin);
		expectInstalled(main.HandwritingPlugin.prototype);
	});
});
