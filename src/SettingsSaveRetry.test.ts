/**
 * A settings save that fails while another change waits behind it.
 *
 * persistSettings clears settingsDirty before it writes, and a change made
 * while a write is in flight only sets the one-deep "write again" latch. When
 * that write fails, the rejection drops the latch, so nothing remembered that
 * a change was still unsaved: flushSettings (the quit and hide path) skips
 * when not dirty, and the change was lost. A failed write now leaves the
 * settings dirty, so the next flush writes them.
 */
import { describe, expect, it } from "vitest";
import HandwritingPlugin from "./main";

type Rec = Record<string, unknown>;
type Proto = {
	settingsFrom(this: unknown, raw: unknown): Rec;
	persistSettings(this: unknown, onHide?: boolean): Promise<void>;
	flushSettings(this: unknown, onHide?: boolean): Promise<void>;
};
const proto = HandwritingPlugin.prototype as unknown as Proto;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Rig extends Rec {
	settings: Rec;
	settingsBaseline: Rec;
	settingsWriting: Promise<void> | null;
	settingsWriteAgain: boolean;
	settingsDirty: boolean;
	settingsReadFailed: boolean;
	settingsTimer: number | null;
	disk: Rec | null | undefined;
	log: string[];
	writes: Rec[];
	gate: (() => void)[];
	failNext: boolean;
}

/** The plugin's own methods over a fake data.json whose writes the test releases by hand. */
function rig(disk: Rec): Rig {
	(globalThis as Rec).window ??= { clearTimeout: () => {}, setTimeout: () => 0 };
	const p = Object.create(HandwritingPlugin.prototype) as Rig;
	p.disk = clone(disk);
	p.settings = proto.settingsFrom.call(p, clone(disk));
	p.settingsBaseline = clone(p.settings);
	p.settingsWriting = null;
	p.settingsWriteAgain = false;
	p.settingsDirty = false;
	p.settingsReadFailed = false;
	p.settingsTimer = null;
	p.log = [];
	p.writes = [];
	p.gate = [];
	p.failNext = false;
	p.loadData = () => {
		p.log.push("read");
		return Promise.resolve(p.disk === undefined ? undefined : clone(p.disk));
	};
	p.saveData = (data: Rec) => {
		p.log.push("write");
		const copy = clone(data);
		const finish = (): Promise<void> => {
			if (p.failNext) {
				p.failNext = false;
				return Promise.reject(new Error("disk full"));
			}
			p.writes.push(copy);
			p.disk = copy;
			return Promise.resolve();
		};
		return new Promise<void>((resolve, reject) => p.gate.push(() => finish().then(resolve, reject)));
	};
	return p;
}
const settle = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("a settings save that fails with a change waiting behind it", () => {
	it("leaves the settings dirty, and the next flush writes the waiting change", async () => {
		const p = rig({ toolbarCorner: "top-left" });
		const first = proto.persistSettings.call(p);
		await settle();
		expect(p.log, "precondition: the first write is in flight").toEqual(["read", "write"]);

		// A change lands while that write is in flight: it only sets the latch.
		p.settings.toolbarCorner = "bottom-left";
		void proto.persistSettings.call(p);
		expect(p.settingsWriteAgain, "precondition: the change waits on the latch").toBe(true);

		p.failNext = true;
		p.gate.shift()!();
		await expect(first).rejects.toThrow("disk full");
		expect(p.writes, "precondition: nothing reached the disk").toHaveLength(0);

		expect(p.settingsDirty, "the failed save forgot the waiting change").toBe(true);

		// Quit or hide: the flush must write it.
		const flushed = proto.flushSettings.call(p);
		await settle();
		p.gate.shift()?.();
		await flushed;
		expect(p.log).toEqual(["read", "write", "read", "write"]);
		expect(p.writes).toHaveLength(1);
		expect(p.disk?.toolbarCorner, "the waiting change reached the disk").toBe("bottom-left");
		expect(p.settingsDirty).toBe(false);
	});
});

describe("a settings save that fails with nothing waiting behind it", () => {
	it("leaves the settings dirty, and the next flush writes the change that failed", async () => {
		const p = rig({ toolbarCorner: "top-left" });
		p.settings.toolbarCorner = "bottom-left";
		const first = proto.persistSettings.call(p);
		await settle();
		expect(p.log, "precondition: the write is in flight").toEqual(["read", "write"]);
		expect(p.settingsWriteAgain, "precondition: nothing waits on the latch").toBe(false);

		p.failNext = true;
		p.gate.shift()!();
		await expect(first).rejects.toThrow("disk full");
		expect(p.writes, "precondition: nothing reached the disk").toHaveLength(0);

		// Dirty only when a change waited on the latch is not enough: the
		// failed write's own change is unsaved too.
		expect(p.settingsDirty, "the failed save forgot its own change").toBe(true);

		const flushed = proto.flushSettings.call(p);
		await settle();
		p.gate.shift()?.();
		await flushed;
		expect(p.log).toEqual(["read", "write", "read", "write"]);
		expect(p.writes).toHaveLength(1);
		expect(p.disk?.toolbarCorner, "the failed change reached the disk").toBe("bottom-left");
		expect(p.settingsDirty).toBe(false);
	});
});
