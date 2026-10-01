/**
 * Audit probe L-settings-1 (1.4.21, tag 1a05f62c). Read-only verifier.
 *
 * Claim: data.json is read once (loadSettings) and every save writes the whole
 * in-memory settings object (persistSettings -> saveData(this.settings)). The
 * plugin does not implement Plugin.onExternalSettingsChange, so when a synced
 * data.json arrives from another device, Obsidian does nothing for it (app.js
 * 1.13.7 `_onConfigFileChange`: `return this.onExternalSettingsChange ? ... : [2]`),
 * and the running device's next unrelated save puts the stale values back.
 *
 * Drives the REAL loadSettings, checkPageIdentity, persistOwners, flushSettings
 * and persistSettings off HandwritingPlugin.prototype (harness pattern from
 * src/SettingsUnknownKeys.test.ts). The host side is modelled the way Obsidian
 * 1.13.7 does it: on a config-file change it calls onExternalSettingsChange only
 * if the plugin defines it.
 *
 * Asserts the CORRECT behaviour: a key another device changed in data.json is
 * not reverted by this device's next unrelated save.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import HandwritingPlugin from "../main";
import { PageIdIndex } from "../model/PageIdIndex";

type Proto = {
	loadSettings(this: unknown): Promise<void>;
	checkPageIdentity(this: unknown, path: string): void;
};
const proto = HandwritingPlugin.prototype as unknown as Proto;

function ensureGlobals(): void {
	const g = globalThis as unknown as { document?: unknown; window?: unknown };
	g.document ??= {
		body: { classList: { add: () => {}, toggle: () => {}, contains: () => false } },
	};
	// persistOwners / checkPageIdentity use window.setTimeout/clearTimeout.
	// Delegate to the (faked) global timers so vi.advanceTimersByTime drives them.
	g.window ??= {
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
		clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
	};
}

interface Harness {
	settings: Record<string, unknown>;
	/** data.json as it sits on this device's disk right now. */
	disk: Record<string, unknown>;
	/** Every object handed to saveData, in order. */
	writes: Record<string, unknown>[];
	onExternalSettingsChange?: () => Promise<void> | void;
}

function fakePlugin(initialDisk: Record<string, unknown>, pageIdFor: Map<string, string>): Harness {
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.disk = { ...initialDisk };
	plugin.writes = [];
	plugin.loadData = (): Promise<unknown> =>
		Promise.resolve(JSON.parse(JSON.stringify(plugin.disk)));
	plugin.saveData = (data: Record<string, unknown>): Promise<void> => {
		const copy = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
		(plugin.writes as Record<string, unknown>[]).push(copy);
		plugin.disk = copy;
		return Promise.resolve();
	};
	plugin.settingsTimer = null;
	plugin.settingsDirty = false;
	plugin.settingsWriting = null;
	plugin.settingsWriteAgain = false;
	plugin.store = { useInkFolder: () => {}, load: () => null, schedule: () => {} };
	plugin.pdfStore = { attachHost: () => {} };
	plugin.pageIds = new PageIdIndex();
	plugin.declaimTimers = new Map<string, number>();
	plugin.declaimedPaths = new Set<string>();
	plugin.ambiguousIds = new Map<string, string[]>();
	plugin.app = {
		workspace: { onLayoutReady: () => {}, iterateAllLeaves: () => {} },
		vault: {
			getFileByPath: (path: string) => (pageIdFor.has(path) ? { path } : null),
		},
		metadataCache: {
			getCache: (path: string) =>
				pageIdFor.has(path)
					? { frontmatter: { "handwriting-page-id": pageIdFor.get(path) } }
					: null,
		},
	};
	plugin.manifest = { version: "1.4.21", dir: ".obsidian/plugins/handwriting" };
	plugin.applyPaperTo = (): void => {};
	plugin.applyBooxMode = (): void => {};
	return plugin as unknown as Harness;
}

/** Obsidian 1.13.7 Plugin._onConfigFileChange, reduced to its gate. */
async function hostSeesConfigFileChange(plugin: Harness): Promise<void> {
	if (typeof plugin.onExternalSettingsChange === "function") {
		await plugin.onExternalSettingsChange();
	}
}

async function scenario(installFixForControl: boolean): Promise<Harness> {
	ensureGlobals();
	const pageIdFor = new Map<string, string>();
	// Desktop's data.json at launch: pressure ON, toolbar top-right.
	const plugin = fakePlugin(
		{ pressureSensitivity: true, toolbarCorner: "top-right", lastSeenVersion: "1.4.21" },
		pageIdFor
	);
	if (installFixForControl) {
		// Control only: what a plugin that honours the host hook would do.
		plugin.onExternalSettingsChange = () => proto.loadSettings.call(plugin);
	}
	await proto.loadSettings.call(plugin);
	// Precondition: the desktop's memory holds the launch values.
	expect(plugin.settings.pressureSensitivity, "precondition: loaded ON").toBe(true);
	expect(plugin.settings.toolbarCorner, "precondition: loaded top-right").toBe("top-right");

	// The iPad turns pressure OFF and moves the toolbar; its data.json syncs
	// in and replaces this device's file.
	plugin.disk = {
		...plugin.disk,
		pressureSensitivity: false,
		toolbarCorner: "top-left",
	};
	await hostSeesConfigFileChange(plugin);
	expect(plugin.disk.pressureSensitivity, "precondition: disk now says OFF").toBe(false);

	// The iPad then inks a new note; it syncs in with a new page id and the
	// metadataCache "changed" handler runs checkPageIdentity for it.
	pageIdFor.set("Synced from iPad.md", "ipadpage01");
	proto.checkPageIdentity.call(plugin, "Synced from iPad.md");
	expect(plugin.writes.length, "precondition: nothing written before the 2 s flush").toBe(0);
	await vi.advanceTimersByTimeAsync(2100);

	// Precondition: the trigger path actually wrote data.json, with the new owner.
	expect(plugin.writes.length, "precondition: persistOwners flushed once").toBe(1);
	expect(
		(plugin.writes[0]!.pageOwners as Record<string, string> | undefined) ?? {},
		"precondition: the write carries the synced page's ownership"
	).toMatchObject({ ipadpage01: "Synced from iPad.md" });
	return plugin;
}

describe("L-settings-1: a setting changed on another device survives this device's next save", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("production plugin: the ownership flush must not write back the stale pressure/toolbar values", async () => {
		const plugin = await scenario(false);
		const written = plugin.writes[0]!;
		expect(
			{ pressureSensitivity: written.pressureSensitivity, toolbarCorner: written.toolbarCorner },
			`data.json after the unrelated save (plugin defines onExternalSettingsChange: ${
				typeof (HandwritingPlugin.prototype as unknown as Harness).onExternalSettingsChange
			})`
		).toEqual({ pressureSensitivity: false, toolbarCorner: "top-left" });
	});

	it("control: the same sequence with a host-hook reload keeps the other device's values", async () => {
		const plugin = await scenario(true);
		const written = plugin.writes[0]!;
		expect({
			pressureSensitivity: written.pressureSensitivity,
			toolbarCorner: written.toolbarCorner,
		}).toEqual({ pressureSensitivity: false, toolbarCorner: "top-left" });
	});
});
