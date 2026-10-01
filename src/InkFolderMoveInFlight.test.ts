/**
 * The Turn on / Turn off button for the ink-folder move must stay disabled for the WHOLE move, including the
 * settle that runs before the store starts holding writes (audit 183). During that span the store does not yet
 * report a move, so a settings row rebuilt then used to hand out a fresh enabled button and a second click
 * started a second move over the same files. The real changeInkFolder and the real settings row run here; only
 * the store and the settle are stand-ins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin, { HandwritingSettingTab } from "./main";
import { inlineInk } from "./inline/InkOverlay";

beforeEach(() => {
	// The row polls for the move's end through window.setInterval; the interval is never allowed to fire here.
	vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => {} });
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function deferred(): { promise: Promise<boolean>; resolve: (v: boolean) => void } {
	let resolve!: (v: boolean) => void;
	const promise = new Promise<boolean>((r) => (resolve = r));
	return { promise, resolve };
}

function rig() {
	const store = {
		movingFolder: false,
		busy: false,
		inkFolder: () => ".handwriting",
		flush: async () => {},
		holdWrites: () => {
			store.movingFolder = true;
		},
		releaseWrites: () => {
			store.movingFolder = false;
		},
		useInkFolder: () => {},
	};
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, any>;
	plugin.store = store;
	plugin.settings = { inkFolder: ".handwriting" };
	plugin.app = { vault: { adapter: { exists: async () => false, list: async () => ({ files: [], folders: [] }) } } };
	plugin.saveSettingsNow = () => {};
	plugin.registerInterval = () => {};
	const settle = deferred();
	vi.spyOn(inlineInk, "settle").mockImplementation(() => settle.promise);
	const real = plugin.changeInkFolder.bind(plugin) as (target: string) => Promise<void>;
	const calls: string[] = [];
	plugin.changeInkFolder = (target: string) => {
		calls.push(target);
		return real(target);
	};
	/** Draw the settings row the way the settings tab does; returns what it did to its button. */
	function drawRow() {
		const log = { disabled: [] as boolean[], click: (): void => {} };
		const button = {
			setButtonText() {
				return this;
			},
			setCta() {
				return this;
			},
			setDisabled(v: boolean) {
				log.disabled.push(v);
				return this;
			},
			onClick(fn: () => void) {
				log.click = fn;
				return this;
			},
		};
		const tab = Object.create(HandwritingSettingTab.prototype) as Record<string, any>;
		tab.plugin = plugin;
		const setting = {
			setName() {
				return this;
			},
			addButton(fn: (b: typeof button) => void) {
				fn(button);
				return this;
			},
			settingEl: { isConnected: true },
		};
		(tab.renderSyncButton as (s: unknown) => void).call(tab, setting);
		return log;
	}
	return { plugin, store, settle, calls, drawRow };
}

describe("ink-folder move guard (audit 183)", () => {
	it("a row rebuilt while the move is still settling draws a disabled button, and a click starts nothing", async () => {
		const r = rig();
		const first = r.drawRow();
		first.click();
		expect(r.calls, "the first click starts the move").toHaveLength(1);
		// The move is in its settle: the store is not holding writes yet.
		expect(r.store.movingFolder).toBe(false);

		const rebuilt = r.drawRow();
		expect(rebuilt.disabled[0], "the rebuilt row's button starts disabled").toBe(true);
		rebuilt.click();
		expect(r.calls, "a second click makes no second move").toHaveLength(1);

		r.settle.resolve(true);
		await new Promise((res) => setTimeout(res, 0));
	});

	it("is enabled again once the move has ended", async () => {
		const r = rig();
		const first = r.drawRow();
		first.click();
		r.settle.resolve(true);
		await new Promise((res) => setTimeout(res, 20));
		expect(r.drawRow().disabled[0]).toBe(false);
	});

	it("the plugin reports a move in flight from the first step and not after it", async () => {
		const r = rig();
		const done = r.plugin.changeInkFolder(".handwriting-x") as Promise<void>;
		expect(r.plugin.inkFolderMoving()).toBe(true);
		r.settle.resolve(false); // settle refuses: outcome busy
		await done;
		expect(r.plugin.inkFolderMoving()).toBe(false);
	});
});
