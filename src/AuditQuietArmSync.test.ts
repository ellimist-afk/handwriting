/**
 * The mouse can be armed for this session only ("quietly"): Toggle eraser or
 * a strip tool clicked with the mouse, on a device that has seen a pen before
 * but not this session. That arm is never stored. A settings sync from another
 * device re-applies the stored mouse setting and turns the arm off: the eraser
 * stays lit, and mouse drags stop erasing.
 */
import { describe, expect, it } from "vitest";
import HandwritingPlugin from "./main";
import { PageIdIndex } from "./model/PageIdIndex";
import { armMouseInkQuietly, mouseInkEnabled, setMouseInk } from "./inline/MouseInk";
import { getInlineEraserMode, setInlineEraserMode } from "./inline/InkOverlay";

type Proto = {
	loadSettings(this: unknown): Promise<void>;
	persistSettings(this: unknown, onHide?: boolean): Promise<void>;
	onExternalSettingsChange(this: unknown): Promise<void>;
};
const proto = HandwritingPlugin.prototype as unknown as Proto;

/** The plugin's own settings methods over a fake data.json. */
function plugin(disk: Record<string, unknown>) {
	const g = globalThis as unknown as { document?: unknown; window?: unknown };
	g.document ??= { body: { classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false } } };
	g.window ??= { setTimeout, clearTimeout };
	const p = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	p.gatedCommandDefs = new Map();
	p.disk = { ...disk };
	p.loadData = () => Promise.resolve(JSON.parse(JSON.stringify(p.disk)));
	p.saveData = (d: unknown) => {
		p.disk = JSON.parse(JSON.stringify(d));
		return Promise.resolve();
	};
	p.settingsTimer = null;
	p.settingsDirty = false;
	p.settingsWriting = null;
	p.settingsWriteAgain = false;
	p.store = {
		useInkFolder: () => {},
		inkFolder: () => ".handwriting",
		holdWrites: () => {},
		releaseWrites: () => {},
		flushDispatch: () => {},
	};
	p.pdfStore = { attachHost: () => {} };
	p.pageIds = new PageIdIndex();
	p.app = {
		workspace: { onLayoutReady: () => {}, iterateAllLeaves: () => {} },
		vault: { adapter: { exists: async () => false, list: async () => ({ files: [], folders: [] }) } },
	};
	p.manifest = { version: "1.4.23", dir: ".obsidian/plugins/handwriting" };
	p.applyPaperTo = () => {};
	p.applyBooxMode = () => {};
	return p;
}

describe("a settings sync from another device", () => {
	it("leaves the mouse armed for this session", async () => {
		setMouseInk(false);
		const p = plugin({ mouseInk: false, pageOwners: {} });
		await proto.loadSettings.call(p);
		// No pen this session: Toggle eraser arms the mouse for the session only.
		setInlineEraserMode(true);
		armMouseInkQuietly();
		expect(mouseInkEnabled(), "precondition: the mouse is armed").toBe(true);

		// Another device claims a note; its data.json (pageOwners) syncs in.
		p.disk = { ...(p.disk as object), pageOwners: { abc: "phone note.md" } };
		await proto.onExternalSettingsChange.call(p);

		expect(getInlineEraserMode(), "precondition: the eraser is still lit").toBe(true);
		expect(mouseInkEnabled(), "the eraser is lit but the mouse no longer erases").toBe(true);
	});
});

describe("a settings save that takes in another device's mouse setting", () => {
	it("applies it to the mouse at once", async () => {
		setMouseInk(false);
		const p = plugin({ mouseInk: false, toolbarCorner: "top-right" });
		await proto.loadSettings.call(p);
		expect(mouseInkEnabled(), "precondition: the mouse does not draw").toBe(false);

		// Another device turns mouse drawing on; its data.json syncs in.
		p.disk = { ...(p.disk as object), mouseInk: true };
		// This device saves another setting before the change is reported.
		(p.settings as Record<string, unknown>).toolbarCorner = "top-left";
		await proto.persistSettings.call(p);

		expect((p.settings as Record<string, unknown>).mouseInk, "precondition: the save took the other device's setting in").toBe(true);
		expect(mouseInkEnabled(), "the settings say the mouse draws, but it does not").toBe(true);
	});
});

describe("the stored mouse setting at startup", () => {
	it("a device whose settings say the mouse draws starts with the mouse drawing", async () => {
		setMouseInk(false);
		const p = plugin({ mouseInk: true });
		await proto.loadSettings.call(p);
		expect(mouseInkEnabled(), "the stored mouse setting was not applied at load").toBe(true);
	});
});
