/**
 * The save at hide or close must not write when this device changed nothing.
 *
 * `persistSettings(true)` has no time to read the file first, so it writes this
 * device's changes over the settings as last read. With no change of its own
 * that write puts back the old value of any setting another device synced in
 * since, and nothing is said.
 *
 * Real `persistSettings`, `flushSettings`, `mergeSettings` and `loadSettings`
 * on the plugin prototype, over a plain in-memory `data.json`. Substituted:
 * `loadData`/`saveData`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import HandwritingPlugin from "./main";
import { FakeAdapter } from "./persistence/FakeAdapter";
import { PageStore } from "./persistence/PageStore";

async function device() {
	const adapter = new FakeAdapter();
	const p = Object.create(HandwritingPlugin.prototype) as Record<string, any>;
	p.disk = { hideStatusBarOnInkedNotes: false };
	p.writes = 0;
	p.loadData = () => Promise.resolve(JSON.parse(JSON.stringify(p.disk)));
	p.saveData = (d: unknown) => {
		p.writes++;
		p.disk = JSON.parse(JSON.stringify(d));
		return Promise.resolve();
	};
	p.settingsTimer = null;
	p.settingsDirty = false;
	p.settingsWriting = null;
	p.settingsWriteAgain = false;
	p.store = new PageStore({ vault: { adapter } } as never);
	p.pdfStore = { attachHost: () => {} };
	p.app = { workspace: { onLayoutReady: () => {}, iterateAllLeaves: () => {} }, vault: { adapter } };
	p.manifest = { version: "1.4.22", dir: ".obsidian/plugins/handwriting" };
	p.applyPaperTo = () => {};
	p.applyBooxMode = () => {};
	p.refreshHeaderActions = () => {};
	p.applyStatusBarVisibility = () => {};
	p.applyGatedCommandRegistration = () => {};
	p.gatedCommandDefs = new Map();
	await p.loadSettings();
	return p;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	vi.stubGlobal("document", { body: { classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false } } });
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("the save at hide when another device changed a setting", () => {
	it("this device changed nothing: nothing is written and the synced value stays", async () => {
		const p = await device();
		p.disk = { ...p.disk, hideStatusBarOnInkedNotes: true }; // another device, synced in, not yet read here
		p.settingsDirty = true;
		const before = p.writes;

		await p.flushSettings(true);

		expect(p.writes - before, "a write with no change of this device's own").toBe(0);
		expect(p.disk.hideStatusBarOnInkedNotes, "the synced value was put back").toBe(true);
		expect(p.settingsDirty, "nothing is owed, so nothing stays marked unsaved").toBe(false);
	});

	it("this device changed a setting: it is written", async () => {
		const p = await device();
		p.settings.penReticle = !p.settings.penReticle;
		p.settingsDirty = true;

		await p.flushSettings(true);

		expect(p.disk.penReticle).toBe(p.settings.penReticle);
	});
});
